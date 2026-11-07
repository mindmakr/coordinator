// Function definitions in one JS/TS file, for the function scanner
// (lib/map/fns.mjs): declarations, arrows bound to a name, class members and
// object methods, each with its body range and qualified name (`Class.m`,
// `obj.m`, `outer>inner`); classes with what they extend and their field types;
// and every parameter list with the body it scopes (lib/map/fn-locals.mjs).
import { bodyAfter, exprEnd, GEN, ID, KEYWORDS, MODS } from './fn-syntax.mjs';

const back = (bare, close) => { let d = 0; let j = close; for (; j >= 0; j--) { if (bare[j] === ')') d++; else if (bare[j] === '(' && --d === 0) break; } return j; };

// ctx: { bare, br (braces), mt (pairs), kind (open → what it opens), lineOf }
export function definitions({ bare, br, mt, kind, lineOf }) {
  const fns = []; const byOpen = new Set(); const defNames = new Set(); const params = [];
  const add = (name, nameAt, open, end) => {
    if (!name || byOpen.has(open) || end < 0) return;
    byOpen.add(open); defNames.add(nameAt);
    fns.push({ name, nameAt, open, end });
  };
  const scope = (from, to, open, end) => { if (end > open) params.push({ text: bare.slice(from, to), open, end }); };
  // An object passed straight to a call holds no functions of its own: `useQuery({ queryFn: () => … })`.
  const inArg = (at) => { const k = kind(br.inner(at)); return k.kind === 'object' && k.arg; };

  // A. function declarations and expressions.
  for (const m of bare.matchAll(new RegExp(`\\bfunction\\b\\s*\\*?\\s*([\\w$]+)?\\s*(?:${GEN})?\\s*\\(`, 'g'))) {
    const paren = m.index + m[0].length - 1;
    const close = mt(paren);
    if (close < 0) continue;
    const open = bodyAfter(bare, close, mt);
    if (open < 0) continue; // an overload or a declaration
    scope(paren + 1, close - 1, open, br.close.get(open) ?? -1);
    let name = m[1]; let nameAt = m[1] ? m.index + m[0].indexOf(m[1], 8) : m.index;
    if (!name) {
      const before = bare.slice(Math.max(0, m.index - 200), m.index);
      const b = /(?:\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=|(?:module\.)?exports\.([\w$]+)\s*=|(?:^|[{,\s])([\w$]+)\s*:|\bexport\s+default)\s*(?:async\s+)?$/.exec(before);
      if (!b) continue;
      name = b[1] ?? b[2] ?? b[3] ?? 'default';
      nameAt = m.index - before.length + b.index;
      if (b[3] && inArg(nameAt)) continue;
    }
    add(name, nameAt, open, br.close.get(open));
  }
  // Bracket depth ( and [ at each offset, built on first use.
  let pd = null;
  const parens = () => { if (!pd) { pd = new Int32Array(bare.length + 1); let d = 0; for (let i = 0; i < bare.length; i++) { pd[i] = d; const c = bare[i]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--; } pd[bare.length] = d; } return pd; };
  // B. arrows: every one scopes its parameters; those bound to a name are functions
  // (const x = () =>, field = async (a) =>, key: x =>, exports.x = () =>).
  for (const m of bare.matchAll(/=>/g)) {
    let p = m.index;
    while (p > 0 && /\s/.test(bare[p - 1])) p--;
    let start;
    // `(a): T =>`: a return type between the parameters and the arrow
    const t = bare[p - 1] === ')' ? null : /\)\s*:\s*[^=;(){}]*$/.exec(bare.slice(Math.max(0, p - 200), p));
    if (bare[p - 1] === ')') start = back(bare, p - 1);
    else if (!t && ID.test(bare[p - 1] ?? '')) { start = p; while (start > 0 && /[\w$]/.test(bare[start - 1])) start--; } else {
      if (!t) continue;
      start = back(bare, p - (t[0].length - t[0].indexOf(')')));
    }
    if (start < 0) continue;
    let s = m.index + 2;
    while (s < bare.length && /\s/.test(bare[s])) s++;
    const end = bare[s] === '{' ? br.close.get(s) ?? -1 : exprEnd(bare, s);
    scope(start, m.index, s, end);
    const before = bare.slice(Math.max(0, start - 200), start);
    if (/\btype\s+[\w$]+(?:\s*<[^=]*>)?\s*=\s*$/.test(before)) continue; // a function type
    // `onClick: () => void` in a type literal: the "body" is a type
    if (bare[s] !== '{' && /^(?:void|string|number|boolean|any|unknown|never|null|undefined|Promise\s*<|[A-Z][\w$.]*\s*(?:<|\[\]|[;,})\n|]|$))/.test(bare.slice(s, end + 1))) continue;
    const b = /(?:\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=|(?:module\.)?exports\.([\w$]+)\s*=|(?:^|[{};,\s])(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[\w$]+)\s*[?!]?\s*(?::[^=;{}]+)?=|(?:^|[{,\s])([\w$]+)\s*:|\bexport\s+default)\s*(?:async\s*)?(?:<[^<>]*>\s*)?$/.exec(before);
    if (!b) continue;
    const name = b[1] ?? b[2] ?? b[3] ?? b[4] ?? 'default';
    if (KEYWORDS.has(name) && name !== 'default') continue;
    const nameAt = start - before.length + b.index + b[0].search(/[\w$#]/);
    const holder = br.inner(nameAt); const hk = kind(holder);
    if (hk.kind === 'type') continue;
    // `key: x =>` only as an object literal's own key; `name = x =>` not as a type annotation
    const opened = (from) => parens()[nameAt] > parens()[from + 1];
    if (b[4] && (hk.kind !== 'object' || hk.arg || opened(holder))) continue;
    if (b[3] && holder >= 0 && opened(holder)) continue;
    add(name, nameAt, s, end);
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
    const k = kind(br.inner(paren));
    if (k.kind !== 'class' && k.kind !== 'object') continue;
    scope(paren + 1, close - 1, open, br.close.get(open) ?? -1);
    if (k.arg) continue;
    add(name, m.index + m[0].lastIndexOf(name, m[0].length - 1), open, br.close.get(open));
  }

  // Nesting, owners and qualified names.
  fns.sort((a, b) => a.open - b.open);
  const out = []; const stack = [];
  const named = (holder) => /\b(?:const|let|var)\s+([\w$]+)\s*=\s*class\b[^{]*$/.exec(bare.slice(Math.max(0, holder - 200), holder))?.[1];
  for (const f of fns) {
    while (stack.length && stack.at(-1).close <= f.open) stack.pop();
    const parent = stack.at(-1) ?? null;
    const holder = br.inner(f.nameAt);
    const hk = kind(holder);
    let q = f.name; let cls = null;
    if (hk.kind === 'class') {
      // a class's name: its own, else the binding it is assigned to (`const X = class {`)
      cls = hk.name ?? named(holder) ?? (/\bexport\s+default\s+class\b[^{]*$/.test(bare.slice(Math.max(0, holder - 200), holder)) ? 'default' : null);
      q = `${cls ?? 'class'}.${f.name}`;
    } else if (hk.kind === 'object' && hk.name !== null && !(parent && parent.open < holder)) {
      q = hk.exportsAll ? f.name : `${hk.name}.${f.name}`;
    }
    if (parent && !cls && parent.open < f.nameAt) q = `${parent.q}>${q}`;
    const rec = { q, name: f.name, line: lineOf(f.nameAt), end: lineOf(Math.max(f.nameAt, f.end - 1)), open: f.open, close: f.end, parent: parent ? out.indexOf(parent) : -1, ...(cls ? { cls } : {}) };
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
    const body = bare.slice(open + 1, close);
    let d = 0; let shallow = ''; // the body with nested blocks blanked: members only
    for (const c of body) { if (c === '{') d++; shallow += d ? (c === '\n' ? c : ' ') : c; if (c === '}') d--; }
    shallow = shallow.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n'); // short runs: the patterns below start with \s*
    const fields = {};
    for (const f of shallow.matchAll(/(?:^|[;{}(,])\s*(?:(?:public|private|protected|static|readonly|override|declare)\s+)*(#?[\w$]+)\s*[?!]?\s*:\s*([A-Z][\w$]*)/gm)) fields[f[1]] ??= f[2];
    for (const f of shallow.matchAll(/(?:^|[;{}])\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[\w$]+)\s*(?::[^=;]+)?=\s*new\s+([\w$]+)/gm)) fields[f[1]] = f[2];
    for (const f of body.matchAll(/\bthis\.(#?[\w$]+)\s*=\s*new\s+([\w$]+)/g)) fields[f[1]] = f[2];
    classes.push({ name: k.name ?? named(open) ?? 'default', line: lineOf(open), ...(k.ext ? { ext: k.ext } : {}), ...(Object.keys(fields).length ? { fields } : {}) });
  }
  return { fns: out, classes: classes.sort((a, b) => a.line - b.line), defNames, params };
}
