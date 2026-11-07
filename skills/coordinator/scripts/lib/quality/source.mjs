// The files the quality signals read: the project's code files (git's list,
// or a walk; lib/map/files.mjs), each with its language, its lines and a
// "bare" view with comments and string contents blanked, so a detector that
// looks at code is not fooled by prose. Tests, fixtures and generated files
// are marked; most detectors skip them (references/quality.md).
import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { listFiles } from '../map/files.mjs';
import { lex, lines as lineIndex } from '../map/lex.mjs';
import { maskLine } from './secretline.mjs';

export const MAX_BYTES = 400 * 1024;
export const MAX_FILES = 20_000;
const LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', mts: 'js', cts: 'js', tsx: 'js',
  py: 'python', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', cs: 'csharp', php: 'php', rs: 'rust', swift: 'swift', dart: 'dart', sql: 'sql',
};
export const TEST = /(^|\/)(__tests__|__mocks__|tests?|e2e|spec|specs|fixtures?|testdata)\/|[._-](test|spec|e2e|stories)\.[a-z]+$|(^|\/)test[-_][^/]+$/i;
export const GENERATED = /(^|\/)(drizzle\/meta|migrations?\/meta|generated|__generated__|\.next|gen)\/|\.(generated|gen|pb)\.[a-z]+$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

export const langOf = (file) => LANG[posix.extname(file).slice(1).toLowerCase()] ?? null;

// Comments and string contents blanked, offsets kept. JS through the map's lexer;
// other languages by a line pass (# and // comments, one-line strings).
export function bareOf(text, lang) {
  if (lang === 'js') return lex(text).bare;
  const hash = ['python', 'ruby'].includes(lang);
  return text.split('\n').map((l) => {
    let out = ''; let q = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '\\') { out += '  '; i++; continue; } if (c === q) { q = null; out += c; } else out += ' '; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
      if ((hash && c === '#') || (!hash && c === '/' && l[i + 1] === '/') || (lang === 'sql' && c === '-' && l[i + 1] === '-')) { out += ' '.repeat(l.length - i); break; }
      out += c;
    }
    return out;
  }).join('\n');
}

export function sourceFile(path, text) {
  const lang = langOf(path);
  let bare = null; let index = null;
  return {
    path, lang, text, lines: text.split('\n'), test: TEST.test(path), generated: GENERATED.test(path),
    get bare() { bare ??= bareOf(text, lang); return bare; },
    lineOf(off) { index ??= lineIndex(text); return index(off); }, // 1-based line of an offset
  };
}

// The project's code files, read once. `only`: a set of relative paths to keep.
export function readSources(root, { only = null } = {}) {
  const out = []; let skipped = 0;
  for (const f of listFiles(root).files) {
    if (!langOf(f) || (only && !only.has(f))) continue;
    if (out.length >= MAX_FILES) { skipped++; continue; }
    const abs = join(root, f);
    try {
      if (statSync(abs).size > MAX_BYTES) { skipped++; continue; }
      const text = readFileSync(abs, 'utf8');
      if (/^[^\n]{5000,}/m.test(text)) { skipped++; continue; } // minified
      out.push(sourceFile(f, text));
    } catch { skipped++; }
  }
  return { files: out, skipped };
}

// One piece of evidence: where, and the line itself, masked (lib/quality/secretline.mjs), trimmed and clipped.
export const at = (f, line) => ({ file: f.path, line, text: maskLine((f.lines[line - 1] ?? '').trim()).slice(0, 160) });