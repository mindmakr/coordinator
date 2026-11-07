// Syntax helpers for the function scanner (lib/map/fns.mjs), all over the lexed
// `bare` text (comments and string contents blanked): brackets, what a `{`
// opens, a body after a parameter list, type arguments, receiver chains.
import { match } from './lex.mjs';

export const KEYWORDS = new Set('if for while switch catch with function return else do try finally typeof instanceof new delete void in of yield await async class extends super this import export default const let var case break continue throw debugger null undefined true false static get set constructor require as satisfies keyof asserts'.split(' '));
export const MODS = /^(?:public|private|protected|static|async|override|readonly|abstract|get|set|declare|accessor)$/;
export const GEN = '<[^<>(){};]*(?:<[^<>(){};]*>[^<>(){};]*)*>'; // type parameters on a declaration, defaults included: <T = Record<K, V>>
export const ID = /[\w$#]/;

// Brace pairs over `bare`, and the innermost `{` holding an offset (-1: top level).
export function braces(bare) {
  const close = new Map(); const parent = new Map(); const stack = []; const marks = [0]; const at = [-1];
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === '{') { parent.set(i, stack.at(-1) ?? -1); stack.push(i); marks.push(i + 1); at.push(i); } else if (bare[i] === '}' && stack.length) { close.set(stack.pop(), i); marks.push(i + 1); at.push(stack.at(-1) ?? -1); }
  }
  const inner = (off) => { let lo = 0; let hi = marks.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (marks[mid] <= off) lo = mid; else hi = mid - 1; } return at[lo]; };
  return { close, parent, inner };
}

// Matching brackets, one pass per kind: open offset → the offset just past its close (-1: none).
// Unbalanced text (a lexing miss) then costs nothing, where a scan per bracket would read to the end each time.
export function pairs(bare) {
  const end = new Int32Array(bare.length).fill(-1);
  const stacks = { '(': [], '[': [], '{': [] }; const opener = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i];
    if (stacks[c]) stacks[c].push(i); else if (opener[c]) { const o = stacks[opener[c]].pop(); if (o !== undefined) end[o] = i + 1; }
  }
  return (i) => (i >= 0 && i < bare.length ? end[i] : -1);
}

// What a `{` opens, from the text before it.
export function kindOf(bare, open) {
  const before = bare.slice(Math.max(0, open - 300), open);
  let m = /\bclass\b(?:\s+([\w$]+))?(?:\s*<[^{}]*?>)?(?:\s+extends\s+([\w$.]+)(?:\s*<[^{}]*?>)?(?:\([^{}]*\))?)?(?:\s+implements\s+[^{}]+?)?\s*$/.exec(before);
  if (m) return { kind: 'class', name: m[1] ?? null, ext: m[2] ?? null };
  if (/\binterface\s+[\w$]+[^{};=]*$/.test(before) || /\btype\s+[\w$]+(?:\s*<[^=]*>)?\s*=\s*$/.test(before) || /\benum\s+[\w$]+\s*$/.test(before)) return { kind: 'type' };
  if ((m = /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*$/.exec(before))) return { kind: 'object', name: m[1] };
  if (/\bmodule\.exports\s*=\s*$/.test(before)) return { kind: 'object', name: '', exportsAll: true };
  if (/\bexport\s+default\s+$/.test(before)) return { kind: 'object', name: 'default' };
  // `arg`: an object passed straight to a call (`useQuery({ queryFn: () => … })`): its functions are the caller's
  if (/[=(,:?[]\s*$|\breturn\s*$|=>\s*$/.test(before)) return { kind: 'object', name: null, arg: /[(,]\s*$/.test(before) };
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
export function exprEnd(bare, s) {
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
export function afterTypeArgs(bare, i) {
  let d = 0; let obj = 0; const stop = Math.min(bare.length, i + 300);
  for (; i < stop; i++) {
    const c = bare[i];
    if (c === '<') d++;
    else if (c === '{') obj++; else if (c === '}') obj--; // `{ a: B; c: D }` is a type literal: its `;` belongs to it
    else if (c === '>' && bare[i - 1] !== '=') { if (--d === 0) break; } else if (c === '(' || c === ')' || ((c === ';' || (c === '=' && bare[i + 1] !== '>')) && obj <= 0)) return -1;
  }
  if (d !== 0 || i >= stop) return -1;
  i++;
  while (i < bare.length && /\s/.test(bare[i])) i++;
  return bare[i] === '(' ? i : -1;
}

// The identifier chain ending at `end` (exclusive): `this.repo`, `a.b.c`, or null.
export function chainBefore(bare, end) {
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
