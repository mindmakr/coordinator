// Structure: how long files and functions are, and how deep blocks nest
// inside a function. Functions are found by pattern on the bare text (JS/TS,
// Go and other brace languages) or by indentation (Python); a heuristic, not
// a parser, so the figures are a distribution, not a verdict.
import { match } from '../map/lex.mjs';
import { at } from './source.mjs';

export const FILE_LONG = 500; // lines
export const FN_LONG = 80; // lines
export const DEEP = 4; // blocks nested inside a function's body

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else', 'do', 'try', 'new', 'typeof', 'await', 'super', 'constructor']);
const BLOCK = /(?:\)|=>|\belse|\btry|\bfinally|\bdo)\s*$/;
const BRACE = new Set(['js', 'go', 'java', 'kotlin', 'csharp', 'php', 'rust', 'swift', 'dart']);

// Where each function's body opens: { name, open } offsets into the bare text.
function braceFunctions(f) {
  const b = f.bare; const out = new Map();
  const bodyAfter = (paren) => {
    const close = match(b, paren);
    if (close < 0) return -1;
    const m = /^\s*(?::\s*[^{=;]*?|->\s*[^{;]*?|\s+throws\s+[^{;]*?|[\w\s.<>?,*&[\]]*?)?\s*(=>\s*)?\{/.exec(b.slice(close, close + 200));
    return m ? close + m[0].length - 1 : -1;
  };
  const add = (name, open) => { if (open >= 0 && !out.has(open) && !KEYWORDS.has(name)) out.set(open, name); };
  const pats = f.lang === 'js'
    ? [/\bfunction\b\s*\*?\s*([\w$]+)?\s*(?:<[^>{}()]*>)?\s*\(/g, /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:<[^>{}()]*>\s*)?\(/g,
      /^[ \t]*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([\w$]+)\s*(?:<[^>{}()]*>)?\s*\(/gm]
    : f.lang === 'go' ? [/^func\s+(?:\([^)]*\)\s*)?([\w]+)\s*(?:\[[^\]]*\])?\(/gm]
      : [/^[ \t]*(?:(?:public|private|protected|internal|static|final|override|async|suspend|open|abstract|pub|fn|fun|func|def|function)\s+)*(?:[\w<>[\],.?]+\s+)?([A-Za-z_]\w*)\s*\(/gm];
  for (const re of pats) for (const m of b.matchAll(re)) add(m[1] ?? 'anonymous', bodyAfter(m.index + m[0].length - 1));
  return [...out].map(([open, name]) => {
    const end = match(b, open);
    if (end < 0) return null;
    // Only blocks count (after `)`, `=>`, else, try, finally, do): object literals and JSX expressions do not.
    const stack = []; let depth = 0; let deepest = 0; let deepAt = open;
    for (let i = open + 1; i < end - 1; i++) {
      if (b[i] === '{') {
        const block = BLOCK.test(b.slice(Math.max(open, i - 12), i));
        stack.push(block);
        if (block && ++depth > deepest) { deepest = depth; deepAt = i; }
      } else if (b[i] === '}' && stack.pop()) depth--;
    }
    return { name, line: f.lineOf(open), end: f.lineOf(end - 1), nest: deepest, nestLine: f.lineOf(deepAt) };
  }).filter(Boolean);
}

function pythonFunctions(f) {
  const out = []; const L = f.bare.split('\n');
  const indent = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  L.forEach((l, i) => {
    const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(l);
    if (!m) return;
    const base = indent(l); let end = i; let deepest = 0; let nestLine = i + 1;
    for (let j = i + 1; j < L.length; j++) {
      if (!L[j].trim()) continue;
      const d = indent(L[j]);
      if (d <= base) break;
      end = j;
      const level = Math.floor((d - base) / 4) - 1; // the body itself is level 0
      if (level > deepest && /:\s*$/.test(L[j - 1] ?? '')) { deepest = level; nestLine = j + 1; }
    }
    out.push({ name: m[2], line: i + 1, end: end + 1, nest: deepest, nestLine });
  });
  return out;
}

export const functionsOf = (f) => (f.lang === 'python' ? pythonFunctions(f) : BRACE.has(f.lang) ? braceFunctions(f) : []);

const quantile = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] : 0);
const dist = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: quantile(s, 0.5), p90: quantile(s, 0.9), max: s.at(-1) ?? 0 }; };

export function structure(all, { focus = null } = {}) {
  const files = all.filter((f) => !f.generated && f.lang !== 'sql' && (!focus || focus.has(f.path)));
  const fileLines = []; const fnLines = []; const longFiles = []; const longFns = []; const deep = [];
  for (const f of files) {
    const n = f.lines.length - (f.lines.at(-1) === '' ? 1 : 0);
    if (!f.test) { fileLines.push(n); if (n > FILE_LONG) longFiles.push({ ...at(f, 1), lines: n }); }
    for (const fn of functionsOf(f)) {
      const len = fn.end - fn.line + 1;
      fnLines.push(len);
      if (f.test) continue; // a long test is a list of cases, not a design problem
      if (len > FN_LONG) longFns.push({ ...at(f, fn.line), name: fn.name, lines: len });
      if (fn.nest >= DEEP) deep.push({ ...at(f, fn.nestLine), name: fn.name, depth: fn.nest });
    }
  }
  const by = (k) => (a, b) => b[k] - a[k] || a.file.localeCompare(b.file);
  return {
    files: dist(fileLines), functions: dist(fnLines),
    longFiles: { count: longFiles.length, top: longFiles.sort(by('lines')).slice(0, 10) },
    longFunctions: { count: longFns.length, top: longFns.sort(by('lines')).slice(0, 10) },
    deepNesting: { count: deep.length, top: deep.sort(by('depth')).slice(0, 10) },
  };
}
