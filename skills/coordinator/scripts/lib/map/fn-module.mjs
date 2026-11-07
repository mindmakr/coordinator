// What one JS/TS file imports, re-exports and exports (export name → local
// name), and the class each local is typed as or built from, for the function
// scanner (lib/map/fns.mjs). Patterns over the lexed text, not a parser.
import { match } from './lex.mjs';

// Imports with the local names they bind, re-exports, and export name → local name.
export function modulePart(code, bare) {
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
