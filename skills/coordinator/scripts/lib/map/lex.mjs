// Two views of a JS/TS source with every offset kept, so a match in either
// maps to the same line: `code` has comments blanked (string contents kept,
// for import paths, routes and keys); `bare` also blanks string, template and
// regex contents (for braces, function bodies and property chains).
// A quote that reaches the end of its line ends there: JSX text such as
// <p>Don't</p> then costs one line, not the rest of the file.
// Not after < or >: in JSX those start `</tag>` and text, far more often than a regex.
const REGEX_BEFORE = new Set('(,=:[!&|?{};+-*%~^'.split(''));
const REGEX_WORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|yield|await|void|delete|throw|new)$/;

const blank = (s) => (s.includes('\n') ? s.split('\n').map((x) => ' '.repeat(x.length)).join('\n') : ' '.repeat(s.length));
const SPECIAL = /[/'"`{}]/g;

export function lex(src) {
  const n = src.length;
  const code = []; const bare = [];
  const stack = []; // brace depth at each open `${`
  let depth = 0; let i = 0; let last = ''; // last significant char of code
  const emit = (from, to, keepCode, keepBare) => {
    const s = src.slice(from, to);
    code.push(keepCode ? s : blank(s)); bare.push(keepBare ? s : blank(s));
  };
  // A template's text from i (after ` or }) to its end or the next ${.
  const template = () => {
    let j = i;
    while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
    emit(i, Math.min(j, n), true, false);
    if (j >= n) { i = n; return; }
    if (src[j] === '`') { emit(j, j + 1, true, true); i = j + 1; last = '`'; return; }
    emit(j, j + 2, true, true); stack.push(depth); depth++; i = j + 2; last = '{';
  };
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; emit(i, j, false, false); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; emit(i, j, false, false); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const end = Math.min(j < n && src[j] === c ? j + 1 : j, n);
      emit(i, i + 1, true, true); emit(i + 1, Math.max(i + 1, end - 1), true, false); if (end - 1 > i) emit(end - 1, end, true, src[end - 1] === c);
      i = end; last = c; continue;
    }
    if (c === '`') { emit(i, i + 1, true, true); i++; template(); continue; }
    // Not `/>` (closes a JSX tag) and not `/ ` (JSX text such as `{a} / {b}`; a regex rarely starts with a space).
    if (c === '/' && d !== '>' && d !== ' ' && (last === '' || REGEX_BEFORE.has(last) || REGEX_WORDS.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let j = i + 1; let cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      // `({a}/{b})</span>` in JSX text reaches the `/` of a closing tag: a regex never ends in `<`.
      if (j < n && src[j] === '/' && src[j - 1] !== '<') { emit(i, i + 1, true, true); emit(i + 1, j, true, false); emit(j, j + 1, true, true); i = j + 1; last = 'x'; continue; }
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (stack.length && stack.at(-1) === depth) { stack.pop(); emit(i, i + 1, true, true); i++; template(); continue; }
    }
    if (c === '{' || c === '}' || c === '/') { emit(i, i + 1, true, true); last = c; i++; continue; }
    // Plain code up to the next character that can open or close something.
    SPECIAL.lastIndex = i + 1;
    const next = SPECIAL.exec(src);
    const j = next ? next.index : n;
    emit(i, j, true, true);
    let k = j - 1;
    while (k >= i && /\s/.test(src[k])) k--;
    if (k >= i) last = src[k];
    i = j;
  }
  return { code: code.join(''), bare: bare.join('') };
}

// Offset → 1-based line, by binary search over the line starts.
export function lines(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return (off) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

// The index just past the bracket matching the one at `open` in `bare`, or -1.
export function match(bare, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const o = bare[open]; const c = pairs[o];
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if (bare[i] === o) depth++;
    else if (bare[i] === c && --depth === 0) return i + 1;
  }
  return -1;
}
