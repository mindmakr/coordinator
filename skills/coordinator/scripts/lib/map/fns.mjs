// Functions and the calls inside them, for one JS/TS file: a small tolerant
// scanner over the lexed text (lib/map/lex.mjs), not a parser, never run.
// Comments and string contents are blanked first, so a call in either is not
// a call. Records each function or method with its line range and the calls
// in its body; lib/map/calls.mjs resolves them across files. The result is
// plain JSON, cached by file hash. Best effort: references/map.md has limits.
import { lex, lines, match } from './lex.mjs';

export const SCAN_VERSION = 7;
const KEYWORDS = new Set('if for while switch catch with function return else do try finally typeof instanceof new delete void in of yield await async class extends super this import export default const let var case break continue throw debugger null undefined true false static get set constructor require'.split(' '));
const MODS = /^(?:public|private|protected|static|async|override|readonly|abstract|get|set|declare|accessor)$/;
const GEN = '<[^<>(){};]*(?:<[^<>(){};]*>[^<>(){};]*)*>'; // type parameters on a declaration, defaults included: <T = Record<K, V>>
const ID = /[\w$#]/;

// Brace pairs over `bare`, and the innermost `{` holding an offset (-1: top level).
function braces(bare) {
  const close = new Map(); const parent = new Map(); const stack = []; const marks = [0]; const at = [-1];
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === '{') { parent.set(i, stack.at(-1) ?? -1); stack.push(i); marks.push(i + 1); at.push(i); } else if (bare[i] === '}' && stack.length) { close.set(stack.pop(), i); marks.push(i + 1); at.push(stack.at(-1) ?? -1); }
  }
  const inner = (off) => { let lo = 0; let hi = marks.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (marks[mid] <= off) lo = mid; else hi = mid - 1; } return at[lo]; };
  return { close, parent, inner };
}

// Matching brackets, one pass per kind: open offset → the offset just past its close (-1: none).
// Unbalanced text (a lexing miss) then costs nothing, where a scan per bracket would read to the end each time.
function pairs(bare) {
  const end = new Int32Array(bare.length).fill(-1);
  const stacks = { '(': [], '[': [], '{': [] }; const opener = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i];
    if (stacks[c]) stacks[c].push(i); else if (opener[c]) { const o = stacks[opener[c]].pop(); if (o !== undefined) end[o] = i + 1; }
  }
  return (i) => (i >= 0 && i < bare.length ? end[i] : -1);
}

// What a `{` opens, from the text before it.
function kindOf(bare, open) {
  const before = bare.slice(Math.max(0, open - 300), open);
  let m = /\bclass\b(?:\s+([\w$]+))?(?:\s*<[^{}]*?>)?(?:\s+extends\s+([\w$.]+)(?:\s*<[^{}]*?>)?(?:\([^{}]*\))?)?(?:\s+implements\s+[^{}]+?)?\s*$/.exec(before);
  if (m) return { kind: 'class', name: m[1] ?? null, ext: m[2] ?? null };
  if (/\binterface\s+[\w$]+[^{};=]*$/.test(before) || /\btype\s+[\w$]+(?:\s*<[^=]*>)?\s*=\s*$/.test(before) || /\benum\s+[\w$]+\s*$/.test(before)) return { kind: 'type' };
  if ((m = /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*$/.exec(before))) return { kind: 'object', name: m[1] };
  if (/\bmodule\.exports\s*=\s*$/.test(before)) return { kind: 'object', name: '', exportsAll: true };
  if (/\bexport\s+default\s+$/.test(before)) return { kind: 'object', name: 'default' };
  if (/[=(,:?[]\s*$|\breturn\s*$|=>\s*$/.test(before)) return { kind: 'object', name: null };
  return { kind: 'block' };
}

// After a parameter list closing at `close` (exclusive): the body's `{` past an optional
// TS return type (`: Promise<A>`, `: { a: B }`, `: A | B`), or -1 when none follows.
export function bodyAfter(bare, close, mt = (i) => match(bare, i)) {
  let i = close; const n = Math.min(bare.length, close + 400);
  while (i < n && /\s/.test(bare[i])) i++;
  if (bare[i] === '{') return i;
  if (bare[i] !== ':') return -1;
  i++;
  let last = ':';
  while (i < n) {
    const c = bare[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') { if (/[\w$>\])}]/.test(last)) return i; const e = mt(i); if (e < 0) return -1; i = e; last = '}'; continue; }
    if (c === '(' || c === '[') { const e = mt(i); if (e < 0) return -1; i = e; last = ')'; continue; }
    if (c === '=' && bare[i + 1] === '>') { i += 2; last = '='; continue; }
    if (c === '<') { let d = 0; for (; i < n; i++) { if (bare[i] === '<') d++; else if (bare[i] === '>' && bare[i - 1] !== '=' && --d === 0) break; } i++; last = '>'; continue; }
    if (/[\w$.?'"`]/.test(c)) { i++; last = c === '.' || c === '?' ? '.' : 'a'; continue; }
    if (c === '|' || c === '&' || c === ',') { i++; last = c; continue; }
    return -1;
  }
  return -1;
}

// The end of an arrow's expression body starting at `s`.
function exprEnd(bare, s) {
  let d = 0;
  for (let i = s; i < bare.length; i++) {
    const c = bare[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) return i; d--; } else if (d === 0 && (c === ';' || c === ',')) return i;
    else if (d === 0 && c === '\n') {
      const prev = bare.slice(s, i).trimEnd().at(-1) ?? '';
      const next = /\S/.exec(bare.slice(i, i + 200));
      const nc = next ? next[0] : '';
      if (!'=+-*/%&|^!?:<>,(.[{'.includes(prev) && !'.?:+-*/%&|^=<>)]}'.includes(nc)) return i;
    }
  }
  return bare.length;
}

// Past type arguments starting at `i` (`<A<{ b: C }>>`) to the `(` of a call, or -1: a comparison, not a call.
function afterTypeArgs(bare, i) {
  let d = 0; const stop = Math.min(bare.length, i + 300);
  for (; i < stop; i++) {
    const c = bare[i];
    if (c === '<') d++;
    else if (c === '>' && bare[i - 1] !== '=') { if (--d === 0) break; } else if (c === '(' || c === ')' || c === ';' || (c === '=' && bare[i + 1] !== '>')) return -1;
  }
  if (d !== 0 || i >= stop) return -1;
  i++;
  while (i < bare.length && /\s/.test(bare[i])) i++;
  return bare[i] === '(' ? i : -1;
}

// Names a function binds itself: its parameters (types and defaults dropped) and what its body declares.
// A call to one of them is a call to a value, not to the file's function of that name.
function shadowOf(params, body) {
  const names = new Set();
  const p = params.replace(/=\s*[^,()]*(?:\([^()]*\))?/g, '').replace(/:\s*[^,(){}]*/g, '');
  for (const m of p.matchAll(/[A-Za-z_$][\w$]*/g)) if (!KEYWORDS.has(m[0]) && !MODS.test(m[0])) names.add(m[0]);
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of body.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]=]*)[}\]]/g)) for (const x of m[1].split(',')) { const id = /([\w$]+)\s*$/.exec(x.replace(/=.*$/, '').trim()); if (id) names.add(id[1]); }
  for (const m of body.matchAll(/\bcatch\s*\(\s*([\w$]+)/g)) names.add(m[1]);
  return [...names].sort();
}

// The identifier chain ending at `end` (exclusive): `this.repo`, `a.b.c`, or null.
function chainBefore(bare, end) {
  let i = end;
  while (i > 0 && /\s/.test(bare[i - 1])) i--;
  if (bare[i - 1] === ')') { // `new X(...)` as a receiver
    let d = 0; let j = i - 1;
    for (; j >= 0; j--) { if (bare[j] === ')') d++; else if (bare[j] === '(' && --d === 0) break; }
    const m = /\bnew\s+([\w$]+)\s*(?:<[^<>]*>)?\s*$/.exec(bare.slice(Math.max(0, j - 120), j));
    return m ? `new ${m[1]}` : '?';
  }
  // Backwards by hand: an end-anchored pattern would retry from every offset.
  const parts = [];
  for (let k = 0; k < 8; k++) {
    let s = i;
    while (s > 0 && ID.test(bare[s - 1])) s--;
    if (s === i) return '?';
    parts.unshift(bare.slice(s, i));
    let j = s;
    while (j > 0 && /\s/.test(bare[j - 1])) j--;
    if (bare[j - 1] !== '.') break;
    j--;
    if (bare[j - 1] === '?') j--;
    while (j > 0 && /\s/.test(bare[j - 1])) j--;
    i = j;
  }
  return parts.join('.');
}

export function scanFns(src) {
  const { code, bare } = lex(src);
  const lineOf = lines(src);
  const br = braces(bare);
  const mt = pairs(bare);
  const kinds = new Map();
  const kind = (open) => { if (open < 0) return { kind: 'top' }; if (!kinds.has(open)) kinds.set(open, kindOf(bare, open)); return kinds.get(open); };
  const fns = []; const byOpen = new Set(); const defNames = new Set();
  const add = (name, nameAt, open, end, params = '') => {
    if (!name || byOpen.has(open) || end < 0) return;
    byOpen.add(open); defNames.add(nameAt);
    fns.push({ name, nameAt, open, end, params });
  };

  // A. function declarations and expressions.
  for (const m of bare.matchAll(new RegExp(`\\bfunction\\b\\s*\\*?\\s*([\\w$]+)?\\s*(?:${GEN})?\\s*\\(`, 'g'))) {
    const paren = m.index + m[0].length - 1;
    const close = mt(paren);
    if (close < 0) continue;
    const open = bodyAfter(bare, close, mt);
    if (open < 0) continue; // an overload or a declaration
    let name = m[1]; let nameAt = m[1] ? m.index + m[0].indexOf(m[1], 8) : m.index;
    if (!name) {
      const before = bare.slice(Math.max(0, m.index - 200), m.index);
      const b = /(?:\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=|(?:module\.)?exports\.([\w$]+)\s*=|(?:^|[{,\s])([\w$]+)\s*:|\bexport\s+default)\s*(?:async\s+)?$/.exec(before);
      if (!b) continue;
      name = b[1] ?? b[2] ?? b[3] ?? 'default';
      nameAt = m.index - before.length + b.index;
    }
    add(name, nameAt, open, br.close.get(open), bare.slice(paren + 1, close - 1));
  }
  // Bracket depth ( and [ at each offset, built on first use.
  let pd = null;
  const parens = () => { if (!pd) { pd = new Int32Array(bare.length + 1); let d = 0; for (let i = 0; i < bare.length; i++) { pd[i] = d; const c = bare[i]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--; } pd[bare.length] = d; } return pd; };
  // B. arrows bound to a name: const x = () =>, field = async (a) =>, key: x =>, exports.x = () =>.
  for (const m of bare.matchAll(/=>/g)) {
    let p = m.index;
    while (p > 0 && /\s/.test(bare[p - 1])) p--;
    let start;
    // `(a): T =>`: a return type between the parameters and the arrow
    const t = bare[p - 1] === ')' ? null : /\)\s*:\s*[^=;(){}]*$/.exec(bare.slice(Math.max(0, p - 200), p));
    if (bare[p - 1] === ')') {
      let d = 0; let j = p - 1;
      for (; j >= 0; j--) { if (bare[j] === ')') d++; else if (bare[j] === '(' && --d === 0) break; }
      start = j;
    } else if (!t && ID.test(bare[p - 1] ?? '')) { start = p; while (start > 0 && /[\w$]/.test(bare[start - 1])) start--; } else {
      if (!t) continue;
      const rp = p - (t[0].length - t[0].indexOf(')'));
      let d = 0; let j = rp;
      for (; j >= 0; j--) { if (bare[j] === ')') d++; else if (bare[j] === '(' && --d === 0) break; }
      start = j;
    }
    if (start < 0) continue;
    const before = bare.slice(Math.max(0, start - 200), start);
    if (/\btype\s+[\w$]+(?:\s*<[^=]*>)?\s*=\s*$/.test(before)) continue; // a function type
    const b = /(?:\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=|(?:module\.)?exports\.([\w$]+)\s*=|(?:^|[{};,\s])(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[\w$]+)\s*[?!]?\s*(?::[^=;{}]+)?=|(?:^|[{,\s])([\w$]+)\s*:|\bexport\s+default)\s*(?:async\s*)?(?:<[^<>]*>\s*)?$/.exec(before);
    if (!b) continue;
    const name = b[1] ?? b[2] ?? b[3] ?? b[4] ?? 'default';
    if (KEYWORDS.has(name) && name !== 'default') continue;
    let s = m.index + 2;
    while (s < bare.length && /\s/.test(bare[s])) s++;
    const nameAt = start - before.length + b.index + b[0].search(/[\w$#]/);
    const holder = br.inner(nameAt); const hk = kind(holder).kind;
    if (hk === 'type') continue;
    // `key: x =>` only as an object literal's own key; `name = x =>` not as a type annotation
    const opened = (from) => parens()[nameAt] > parens()[from + 1];
    if (b[4] && (hk !== 'object' || opened(holder))) continue;
    if (b[3] && holder >= 0 && opened(holder)) continue;
    if (bare[s] === '{') add(name, nameAt, s, br.close.get(s), bare.slice(start, m.index));
    else add(name, nameAt, s, exprEnd(bare, s), bare.slice(start, m.index));
  }
  // C. methods: class members and object shorthand, `name(…) {`.
  for (const m of bare.matchAll(new RegExp(`(?:^|[{};,])[ \\t]*((?:[\\w$]+[ \\t]+)*)\\*?[ \\t]*(#?[\\w$]+)[ \\t]*[?!]?[ \\t]*(?:${GEN})?[ \\t]*\\(`, 'gm'))) {
    const name = m[2];
    if (KEYWORDS.has(name) && name !== 'constructor' && name !== 'get' && name !== 'set') continue;
    if (m[1].trim() && !m[1].trim().split(/\s+/).every((w) => MODS.test(w))) continue;
    const paren = m.index + m[0].length - 1;
    const close = mt(paren);
    if (close < 0) continue;
    const open = bodyAfter(bare, close, mt);
    if (open < 0) continue;
    const k = kind(br.inner(m.index + m[0].length - 1)).kind;
    if (k !== 'class' && k !== 'object') continue;
    add(name, m.index + m[0].lastIndexOf(name, m[0].length - 1), open, br.close.get(open), bare.slice(paren + 1, close - 1));
  }

  // Nesting, owners and qualified names.
  fns.sort((a, b) => a.open - b.open);
  const out = [];
  const stack = [];
  for (const f of fns) {
    while (stack.length && stack.at(-1).close <= f.open) stack.pop();
    const parent = stack.at(-1) ?? null;
    const holder = br.inner(f.nameAt);
    const hk = kind(holder);
    let q = f.name; let cls = null; let owner = null;
    if (hk.kind === 'class') {
      // a class's name: its own, else the binding it is assigned to (`const X = class {`)
      cls = hk.name ?? /\b(?:const|let|var)\s+([\w$]+)\s*=\s*class\b[^{]*$/.exec(bare.slice(Math.max(0, holder - 200), holder))?.[1] ?? (/\bexport\s+default\s+class\b[^{]*$/.test(bare.slice(Math.max(0, holder - 200), holder)) ? 'default' : null);
      q = `${cls ?? 'class'}.${f.name}`;
    } else if (hk.kind === 'object' && hk.name !== null && !(parent && parent.open < holder)) {
      owner = hk.name; q = hk.exportsAll ? f.name : `${hk.name}.${f.name}`;
    }
    if (parent && !cls && parent.open < f.nameAt) q = `${parent.q}>${q}`;
    const rec = { shadow: shadowOf(f.params, bare.slice(f.open, f.end)), q, name: f.name, line: lineOf(f.nameAt), end: lineOf(Math.max(f.nameAt, f.end - 1)), open: f.open, close: f.end, parent: parent ? out.indexOf(parent) : -1, ...(cls ? { cls } : {}), ...(owner !== null ? { owner } : {}) };
    out.push(rec);
    stack.push(rec);
  }
  const seenQ = new Map();
  for (const f of out) { const n = (seenQ.get(f.q) ?? 0) + 1; seenQ.set(f.q, n); if (n > 1) f.q = `${f.q}~${n}`; }

  // Classes: name, line, what they extend, field types for `this.x.y()`.
  const classes = [];
  for (const [open, close] of br.close) {
    const k = kind(open);
    if (k.kind !== 'class') continue;
    const name = k.name ?? /\b(?:const|let|var)\s+([\w$]+)\s*=\s*class\b[^{]*$/.exec(bare.slice(Math.max(0, open - 200), open))?.[1] ?? 'default';
    const body = bare.slice(open + 1, close);
    let d = 0; let shallow = ''; // the body with nested blocks blanked: members only
    for (const c of body) { if (c === '{') d++; shallow += d ? (c === '\n' ? c : ' ') : c; if (c === '}') d--; }
    shallow = shallow.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n'); // short runs: the patterns below start with \s*
    const fields = {};
    for (const f of shallow.matchAll(/(?:^|[;{}(,])\s*(?:(?:public|private|protected|static|readonly|override|declare)\s+)*(#?[\w$]+)\s*[?!]?\s*:\s*([A-Z][\w$]*)/gm)) fields[f[1]] ??= f[2];
    for (const f of shallow.matchAll(/(?:^|[;{}])\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[\w$]+)\s*(?::[^=;]+)?=\s*new\s+([\w$]+)/gm)) fields[f[1]] = f[2];
    for (const f of body.matchAll(/\bthis\.(#?[\w$]+)\s*=\s*new\s+([\w$]+)/g)) fields[f[1]] = f[2];
    classes.push({ name, line: lineOf(open), ...(k.ext ? { ext: k.ext } : {}), ...(Object.keys(fields).length ? { fields } : {}) });
  }

  // Calls (and identifiers passed as callbacks), each in its innermost function.
  const owners = out.map((f, i) => [f.open, f.close, i]);
  const ownerAt = (off) => { let best = -1; for (const [o, c, i] of owners) if (o <= off && off < c && (best < 0 || o >= owners[best][0])) best = i; return best; };
  const calls = out.map(() => []); const top = [];
  const push = (off, c) => { const o = ownerAt(off); (o < 0 ? top : calls[o]).push(c); };
  for (const m of bare.matchAll(/(#?[\w$]+)\s*(?:\?\.\s*)?(?=[<(])/g)) {
    const name = m[1];
    const at = m.index;
    if (/[\w$]/.test(bare[at - 1] ?? '') || /^\d/.test(name) || defNames.has(at)) continue;
    const pre = bare.slice(Math.max(0, at - 40), at);
    const isNew = /\bnew\s+$/.test(pre);
    const member = /(?<!\.)\??\.\s*$/.test(pre); // after a dot any name is a method: map.get(), x.delete()
    if (!member && ((KEYWORDS.has(name) && name !== 'get' && name !== 'set') || /\bfunction\s*\*?\s*$/.test(pre))) continue;
    let paren = at + m[0].length;
    if (bare[paren] === '<') { paren = afterTypeArgs(bare, paren); if (paren < 0) continue; }
    const close = mt(paren);
    // A definition (`name(a): T {`) starts a statement or a member; after `?`, `=`, `(` or `return` it is a call (`c ? f(x) : g(y)`).
    const startsMember = /(?:^|[\n{};,*]|\b(?:async|static|get|set|public|private|protected|override|readonly))\s*$/.test(pre);
    if (close > 0 && startsMember && !isNew && bodyAfter(bare, close, mt) >= 0) continue;
    const hk = kind(br.inner(at)).kind;
    if (hk === 'type') continue;
    if (hk === 'class' && !/[=(,:?]\s*$/.test(pre)) continue; // a member signature
    const dot = /(?<!\.)\??\.\s*$/.exec(pre); // not a spread: ...f()
    const recv = dot ? chainBefore(bare, at - dot[0].length) : null;
    push(at, { n: name, ...(recv ? { r: recv } : {}), ...(isNew ? { k: 'new' } : {}), line: lineOf(at) });
    // Bare identifiers (or this.x) passed as arguments: maybe callbacks.
    if (close > 0 && close - paren < 2000) {
      const args = bare.slice(paren + 1, close - 1);
      for (const a of args.matchAll(/(?:^|,)\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*(?=,|$)/g)) {
        if (KEYWORDS.has(a[1])) continue;
        const r = a[1].startsWith('this.') ? { n: a[1].slice(5), r: 'this' } : { n: a[1] };
        push(paren + 1 + a.index, { ...r, k: 'ref', line: lineOf(paren + 1 + a.index) });
      }
    }
  }
  // JSX handlers: onClick={handleSubmit}, onChange={this.update}.
  for (const m of bare.matchAll(/[\w$-]+=\{\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*\}/g)) {
    if (KEYWORDS.has(m[1])) continue;
    const at = m.index + m[0].indexOf('{') + 1;
    push(at, { ...(m[1].startsWith('this.') ? { n: m[1].slice(5), r: 'this' } : { n: m[1] }), k: 'ref', line: lineOf(at) });
  }

  // A passed identifier counts only when it can name a function: one of this file's, or an import.
  const mod = modulePart(code, bare);
  const known = new Set([...out.map((f) => f.name), ...mod.imports.flatMap((i) => Object.keys(i.locals))]);
  const keep = (c) => c.k !== 'ref' || c.r === 'this' || known.has(c.n);
  for (let i = 0; i < calls.length; i++) calls[i] = calls[i].filter(keep);
  return {
    v: SCAN_VERSION, ...mod,
    classes: classes.sort((a, b) => a.line - b.line),
    fns: out.map((f, i) => ({ q: f.q, name: f.name, line: f.line, end: f.end, ...(f.parent >= 0 ? { parent: out[f.parent].q } : {}), ...(f.cls ? { cls: f.cls } : {}), ...(f.shadow.length ? { shadow: f.shadow } : {}), calls: calls[i] })),
    top: top.filter(keep),
  };
}

// Imports with the local names they bind, re-exports, and export name → local name.
function modulePart(code, bare) {
  const imports = [];
  const take = (spec, locals, extra = {}) => imports.push({ spec, locals, ...extra });
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([\w$]+\s*,\s*(?:\*\s*as\s+[\w$]+|\{[^}]*\})|[\w$]+|\*\s*as\s+[\w$]+|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g)) {
    const locals = {};
    const brace = /\{([^}]*)\}/.exec(m[1]);
    if (brace) for (const p of brace[1].split(',')) { const x = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(p); if (x) locals[x[2] ?? x[1]] = x[1]; }
    for (const h of m[1].replace(/\{[^}]*\}/, '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const star = /^\*\s+as\s+([\w$]+)$/.exec(h);
      if (star) locals[star[1]] = '*'; else if (/^[\w$]+$/.test(h)) locals[h] = 'default';
    }
    take(m[3], locals);
  }
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?(\*(?:\s+as\s+([\w$]+))?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g)) {
    if (m[1].startsWith('*')) take(m[4], {}, { reexport: m[2] ? [['*', m[2]]] : '*' });
    else take(m[4], {}, { reexport: m[1].slice(1, -1).split(',').map((p) => /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(p)).filter(Boolean).map((x) => [x[1], x[2] ?? x[1]]) });
  }
  // require and import(): `const x = require('m')`, `const { a, b: c } = require('m')`, `await import('m')`.
  for (const m of code.matchAll(/\b(?:const|let|var)\s*(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
    const locals = {};
    if (m[1].startsWith('{')) for (const p of m[1].slice(1, -1).split(',')) { const x = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?/.exec(p); if (x) locals[x[2] ?? x[1]] = x[1]; } else locals[m[1]] = '*';
    take(m[3], locals, { bound: true }); // bound inside a body: its own declaration, not a shadow
  }
  const exports = {};
  for (const m of bare.matchAll(/\bexport\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s*([\w$]+)?/g)) {
    if (m[2]) exports[m[1] ? 'default' : m[2]] = m[2];
    else if (m[1]) exports.default = 'default';
    if (m[1] && m[2]) exports[m[2]] ??= m[2];
  }
  for (const m of bare.matchAll(/\bexport\s+default\s+([\w$]+)\s*[;\n]/g)) if (!/^(?:function|class|async|abstract|new)$/.test(m[1])) exports.default = m[1];
  for (const m of bare.matchAll(/\bexport\s+default\s+(?:async\s+)?(?:\(|[\w$]+\s*=>)/g)) exports.default ??= 'default';
  for (const m of bare.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) for (const p of m[1].split(',')) { const x = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(p); if (x) exports[x[2] ?? x[1]] = x[1]; }
  for (const m of bare.matchAll(/\b(?:module\.)?exports\.([\w$]+)\s*=\s*([\w$]+)?/g)) exports[m[1]] = m[2] && !/^(?:function|async|class)$/.test(m[2]) && !/^\s*(?:\(|=>)/.test(bare.slice(m.index + m[0].length, m.index + m[0].length + 4)) ? m[2] : m[1];
  for (const m of bare.matchAll(/\bmodule\.exports\s*=\s*([\w$]+)\s*[;\n]/g)) exports.default = m[1];
  for (const m of bare.matchAll(/\bmodule\.exports\s*=\s*\{/g)) {
    const open = m.index + m[0].length - 1; const end = match(bare, open);
    if (end < 0) continue;
    let d = 0; let s = open + 1;
    const parts = [];
    for (let i = open + 1; i < end - 1; i++) { const c = bare[i]; if ('{[('.includes(c)) d++; else if ('}])'.includes(c)) d--; else if (c === ',' && d === 0) { parts.push(bare.slice(s, i)); s = i + 1; } }
    parts.push(bare.slice(s, end - 1));
    for (const p of parts) { const x = /^\s*(?:async\s+)?\*?\s*([\w$]+)\s*(?::\s*([\w$]+)\s*$)?/.exec(p); if (x) exports[x[1]] = x[2] ?? x[1]; }
    exports.default ??= '';
  }
  // Locals typed or built from a class: `const svc = new Svc()`, `(svc: Svc)`, `let s: Svc =`.
  const types = {};
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::\s*[\w$<>[\]]+\s*)?=\s*(?:await\s+)?new\s+([\w$]+)/g)) types[m[1]] ??= m[2];
  for (const m of bare.matchAll(/(?:[(,]|\b(?:const|let|var))\s*([\w$]+)\s*\??\s*:\s*([A-Z][\w$]*)\b(?!\s*[<.[])/g)) types[m[1]] ??= m[2];
  return { imports, exports, types };
}
