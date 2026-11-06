// Where an import lands: a project file, an outside package, or unresolved.
// Handles relative paths (with the .js → .ts swap of TS ESM), tsconfig or
// jsconfig `baseUrl` and `paths` (following relative `extends`), and the
// project's own workspace packages by name and `exports`. Lookups go against
// the file list, never the disk, so a resolve costs a few set lookups.
import { builtinModules } from 'node:module';
import { posix } from 'node:path';

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const SWAP = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const BUILTIN = new Set(builtinModules);
const CONDITIONS = ['source', 'development', 'import', 'module', 'default', 'require', 'node', 'types'];

// JSON with comments and trailing commas (tsconfig), or null.
export function jsonc(text) {
  try { return JSON.parse(text); } catch { /* try the lenient form */ }
  let out = ''; let str = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

const norm = (p) => { const n = posix.normalize(p); return n === '.' ? '' : n.replace(/^\.\//, ''); };
export const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

function pickCondition(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const r = pickCondition(x); if (r) return r; } return null; }
  if (v && typeof v === 'object') {
    for (const k of CONDITIONS) if (k in v) { const r = pickCondition(v[k]); if (r) return r; }
    for (const x of Object.values(v)) { const r = pickCondition(x); if (r) return r; }
  }
  return null;
}

// package.json `exports` for a subpath ('.' or './x'): its target, or null.
export function exportTarget(exp, sub) {
  if (exp == null) return null;
  if (typeof exp === 'string' || Array.isArray(exp)) return sub === '.' ? pickCondition(exp) : null;
  const keys = Object.keys(exp);
  if (!keys.some((k) => k.startsWith('.'))) return sub === '.' ? pickCondition(exp) : null;
  if (sub in exp) return pickCondition(exp[sub]);
  for (const k of keys) {
    const star = k.indexOf('*');
    if (star < 0) continue;
    const pre = k.slice(0, star); const post = k.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
      const t = pickCondition(exp[k]);
      if (t) return t.replace('*', sub.slice(pre.length, sub.length - post.length));
    }
  }
  return null;
}

export function resolver(files, read) {
  const set = new Set(files);
  const configs = new Map(); // dir → { base, paths } | null
  const packages = [];
  for (const f of files) {
    if (posix.basename(f) !== 'package.json') continue;
    const j = jsonc(read(f) ?? '');
    if (j && typeof j.name === 'string') packages.push({ name: j.name, dir: posix.dirname(f) === '.' ? '' : posix.dirname(f), json: j });
  }
  packages.sort((a, b) => b.name.length - a.name.length);

  function tryFile(p) {
    p = norm(p);
    if (set.has(p)) return p;
    const ext = posix.extname(p);
    for (const s of SWAP[ext] ?? []) { const q = p.slice(0, -ext.length) + s; if (set.has(q)) return q; }
    for (const e of EXTS) if (set.has(p + e)) return p + e;
    for (const e of EXTS) if (set.has(`${p}${p ? '/' : ''}index${e}`)) return `${p}${p ? '/' : ''}index${e}`;
    return null;
  }

  // A tsconfig's baseUrl and paths, with `extends` (relative files only) merged under it.
  function loadConfig(file, seen = new Set()) {
    if (seen.has(file) || !set.has(file)) return null;
    seen.add(file);
    const j = jsonc(read(file) ?? '');
    if (!j) return null;
    const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    let out = { base: null, paths: [] };
    for (const ext of [j.extends].flat().filter((e) => typeof e === 'string' && e.startsWith('.'))) {
      const parent = loadConfig(norm(posix.join(dir, ext.endsWith('.json') ? ext : `${ext}.json`)), seen);
      if (parent) out = { base: parent.base, paths: parent.paths };
    }
    const o = j.compilerOptions ?? {};
    if (typeof o.baseUrl === 'string') out.base = norm(posix.join(dir, o.baseUrl));
    if (o.paths && typeof o.paths === 'object') {
      const root = out.base ?? dir;
      out.paths = Object.entries(o.paths).map(([pat, targets]) => {
        const star = pat.indexOf('*');
        return { pre: star < 0 ? pat : pat.slice(0, star), post: star < 0 ? null : pat.slice(star + 1), targets: [targets].flat().map((t) => norm(posix.join(root, t))) };
      });
    }
    return out;
  }

  function configFor(dir) {
    if (configs.has(dir)) return configs.get(dir);
    let c = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const f = dir ? `${dir}/${name}` : name;
      if (set.has(f)) { c = loadConfig(f); break; }
    }
    if (!c && dir) c = configFor(posix.dirname(dir) === '.' ? '' : posix.dirname(dir));
    configs.set(dir, c);
    return c;
  }

  function viaPackage(spec) {
    const p = packages.find((x) => spec === x.name || spec.startsWith(`${x.name}/`));
    if (!p) return null;
    const rest = spec.slice(p.name.length + 1);
    const sub = rest ? `./${rest}` : '.';
    const tries = [];
    const t = exportTarget(p.json.exports, sub);
    if (t) tries.push(t, t.replace(/(^|\/)(dist|build|lib|out)\//, '$1src/'));
    if (sub === '.') tries.push(...['source', 'module', 'main', 'types'].map((k) => p.json[k]).filter((x) => typeof x === 'string'), 'src/index', 'index');
    else tries.push(rest, `src/${rest}`);
    for (const x of tries) { const f = tryFile(posix.join(p.dir, x.replace(/\.d\.ts$/, ''))); if (f) return f; }
    return null;
  }

  // { to } a project file | { ext } an outside package or node builtin | { unresolved }
  return function resolve(spec, from) {
    const dir = posix.dirname(from) === '.' ? '' : posix.dirname(from);
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const f = tryFile(spec.startsWith('/') ? spec.slice(1) : posix.join(dir, spec));
      return f ? { to: f } : { unresolved: spec };
    }
    if (spec.startsWith('node:') || BUILTIN.has(spec.split('/')[0])) return { ext: spec.startsWith('node:') ? spec : `node:${spec}` };
    const c = configFor(dir);
    for (const m of c?.paths ?? []) {
      let mid = null;
      if (m.post === null) { if (spec === m.pre) mid = ''; } else if (spec.startsWith(m.pre) && spec.endsWith(m.post)) mid = spec.slice(m.pre.length, spec.length - m.post.length);
      if (mid === null) continue;
      for (const t of m.targets) { const f = tryFile(t.replace('*', mid)); if (f) return { to: f }; }
    }
    if (c?.base != null) { const f = tryFile(posix.join(c.base, spec)); if (f) return { to: f }; }
    const w = viaPackage(spec);
    if (w) return { to: w };
    if (c?.paths?.some((m) => m.post !== null && spec.startsWith(m.pre) && m.pre)) return { unresolved: spec };
    return { ext: pkgName(spec) };
  };
}
