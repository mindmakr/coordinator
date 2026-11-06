// The fallback for languages other than JS/TS: import-like lines by pattern,
// resolved against the file list where the spelling allows (relative paths,
// dotted module paths, Go packages by directory). What does not resolve is an
// outside package. No functions, settings or surfaces for these languages.
import { posix } from 'node:path';

const LANG = {
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', rb: 'ruby', php: 'php',
  c: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', dart: 'dart', swift: 'swift', scala: 'scala', ex: 'elixir', exs: 'elixir',
};
const PATTERNS = {
  python: [/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)/gm, /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm],
  go: [/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm, /^\s*(?:[\w.]+\s+)?"([^"]+)"\s*$/gm],
  rust: [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm], kotlin: [/^\s*import\s+([\w.]+)/gm], scala: [/^\s*import\s+([\w.]+)/gm],
  ruby: [/^\s*require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/gm], php: [/^\s*use\s+([\w\\]+)/gm, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
  c: [/^\s*#\s*include\s*"([^"]+)"/gm], cpp: [/^\s*#\s*include\s*"([^"]+)"/gm], csharp: [/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm],
  dart: [/^\s*(?:import|export)\s+['"]([^'"]+)['"]/gm], swift: [/^\s*import\s+(\w+)/gm], elixir: [/^\s*(?:alias|import|use)\s+([\w.]+)/gm],
};

export const langOf = (file) => LANG[posix.extname(file).slice(1).toLowerCase()] ?? null;

// Go: a block import ( "a" "b" ) is read by the second pattern, only inside the block.
function goSpecs(src) {
  const out = [];
  for (const m of src.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1]);
  for (const b of src.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const m of b[1].matchAll(/"([^"]+)"/g)) out.push(m[1]);
  return out;
}

export function scanOther(src, file) {
  const lang = langOf(file);
  if (!lang) return null;
  if (lang === 'go') return { lang, specs: goSpecs(src), lines: src.split('\n').length };
  const specs = [];
  for (const re of PATTERNS[lang]) {
    for (const m of src.matchAll(re)) {
      if (lang === 'python' && re.source.startsWith('^\\s*from')) {
        // from a import b: b may be a module (a/b.py) or a name in a; the build keeps what resolves.
        const base = m[1];
        if (!/^\.+$/.test(base)) specs.push(base);
        for (const n of m[2].replace(/[()]/g, '').split(',').map((x) => x.trim()).filter((x) => /^\w+$/.test(x))) specs.push(/^\.+$/.test(base) ? `${base}${n}` : `${base}.${n}`);
      } else if (lang === 'python') for (const s of m[1].split(',')) specs.push(s.trim());
      else if (lang === 'ruby' && /require_relative/.test(m[0])) specs.push(`./${m[1].replace(/^\.\//, '')}`);
      else specs.push(m[1]);
    }
  }
  return { lang, specs: [...new Set(specs)].filter(Boolean), lines: src.split('\n').length };
}

// Resolves against an index of the files (built once per map).
export function looseIndex(files) {
  const byStem = new Map(); // path without extension → file
  const byDir = new Map(); // directory → files in it
  const byBase = new Map(); // last segment of the stem → stems
  for (const f of files) {
    if (!langOf(f)) continue;
    const stem = f.replace(/\.[^./]+$/, '');
    byStem.set(stem, f);
    const b = stem.split('/').pop();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(stem);
    const d = posix.dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const goMod = files.includes('go.mod') ? 'go.mod' : null;
  return { byStem, byDir, byBase, goMod };
}

const suffix = (index, stem) => {
  if (index.byStem.has(stem)) return [index.byStem.get(stem)];
  for (const k of index.byBase.get(stem.split('/').pop()) ?? []) if (k.endsWith(`/${stem}`)) return [index.byStem.get(k)];
  return [];
};

// → { to: [files] } | { ext: name }
export function resolveLoose(spec, from, lang, index, goModule = null) {
  const dir = posix.dirname(from);
  const rel = (p) => posix.normalize(posix.join(dir, p));
  let hits = [];
  if (lang === 'python') {
    const dots = /^\.*/.exec(spec)[0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    if (dots) {
      const base = posix.normalize(posix.join(dir, '../'.repeat(dots - 1), rest));
      hits = [index.byStem.get(base), index.byStem.get(`${base}/__init__`)].filter(Boolean);
    } else hits = [...suffix(index, rest), ...suffix(index, `${rest}/__init__`)].slice(0, 1);
  } else if (lang === 'go') {
    const local = goModule && spec.startsWith(`${goModule}/`) ? spec.slice(goModule.length + 1) : null;
    if (local !== null) hits = (index.byDir.get(local) ?? []).filter((f) => !f.endsWith('_test.go')).slice(0, 20);
  } else if (lang === 'rust') {
    if (!spec.includes('::')) hits = [index.byStem.get(rel(spec)), index.byStem.get(rel(`${spec}/mod`))].filter(Boolean);
    else {
      const parts = spec.split('::'); const root = parts[0] === 'crate' ? 'src' : parts[0] === 'super' ? posix.dirname(dir) : parts[0] === 'self' ? dir : null;
      if (root !== null) for (let n = parts.length; n > 1 && !hits.length; n--) { const p = posix.join(root, ...parts.slice(1, n)); hits = [index.byStem.get(p), index.byStem.get(`${p}/mod`)].filter(Boolean); }
    }
  } else if (['c', 'cpp', 'dart', 'ruby', 'php'].includes(lang) && /^\.{0,2}\/|^[\w-]+\//.test(spec) && /\.\w+$|^\./.test(spec)) {
    const p = spec.replace(/^package:[\w-]+\//, 'lib/');
    hits = [index.byStem.get(rel(p).replace(/\.[^./]+$/, '')), ...suffix(index, p.replace(/\.[^./]+$/, '').replace(/^\.\//, ''))].filter(Boolean).slice(0, 1);
  } else if (lang === 'dart' && spec.startsWith('package:')) hits = suffix(index, `lib/${spec.replace(/^package:[\w-]+\//, '').replace(/\.dart$/, '')}`);
  else if (['java', 'kotlin', 'scala', 'csharp', 'elixir', 'php', 'ruby'].includes(lang)) {
    const parts = spec.split(/[.\\]/);
    for (let s = 0; s < parts.length - 1 && !hits.length; s++) hits = suffix(index, parts.slice(s).join('/'));
  }
  hits = hits.filter((f) => f !== from);
  return hits.length ? { to: hits } : { ext: spec.split(/[/.:\\]/)[0] || spec };
}
