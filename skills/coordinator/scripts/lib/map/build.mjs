// Builds the project map from the code: modules and imports, shared helpers
// and who uses them, settings and env keys with where they are read and
// written, surfaces (routes, screens, message keys) tied to what is behind
// them, and reuse candidates. Read-only; capped in time (a capped build is
// marked partial). Every record has an `id`; every list is sorted.
import { readFileSync, statSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { inferRepo } from '../links.mjs';
import { ENV_TEMPLATE, gitHead, JS, listFiles, OTHER } from './files.mjs';
import { analyse } from './js.mjs';
import { langOf, looseIndex, resolveLoose, scanOther } from './other.mjs';
import { resolver } from './resolve.mjs';
import { callMatches, catalogs, fileSurfaces, segs } from './surfaces.mjs';

const MAX_BYTES = 1024 * 1024;
const SERVICE = /servic|repositor|controller|use-?case|actions?\b|quer(y|ies)|mutation|store|hooks?\/|\/api\/|\/lib\//i;
const sorted = (xs) => [...new Set(xs)].sort();
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildMap(root, { maxSeconds = 60, now = Date.now } = {}) {
  const t0 = now(); const deadline = t0 + maxSeconds * 1000;
  const ms = {};
  const files = listFiles(root, Date.now() + maxSeconds * 1000); // the walk keeps real time, whatever clock the caller passes
  ms.list = now() - t0;
  const cache = new Map();
  const read = (f) => {
    if (cache.has(f)) return cache.get(f);
    let text = null;
    try { const p = join(root, f); if (statSync(p).size <= MAX_BYTES) text = readFileSync(p, 'utf8'); } catch { /* gone or unreadable */ }
    cache.set(f, text);
    return text;
  };

  // 1. Scan: every source file once, until the time cap.
  const t1 = now();
  const info = new Map(); let partial = false;
  for (const f of files) {
    if (!JS.test(f) && !OTHER.test(f)) continue;
    if (now() > deadline) { partial = true; break; }
    const src = read(f);
    if (src === null || /^[^\n]{5000,}/.test(src)) continue; // too big, or minified
    cache.delete(f); // keep memory flat on large projects
    info.set(f, JS.test(f) ? { lang: 'js', ...analyse(src, f) } : scanOther(src, f));
  }
  ms.scan = now() - t1;

  // 2. Link: resolve imports, then everything that hangs off them.
  const t2 = now();
  const resolve = resolver(files, read);
  const loose = looseIndex(files);
  const goModule = files.includes('go.mod') ? /^module\s+(\S+)/m.exec(read('go.mod') ?? '')?.[1] ?? null : null;
  const modules = []; const edges = new Map(); // file → [{ to, imp }]
  let unresolved = 0; const external = new Map();
  for (const [f, a] of info) {
    const out = []; const ext = new Set(); const bad = new Set();
    if (a.lang === 'js') {
      for (const imp of a.imports) {
        const r = resolve(imp.spec, f);
        if (r.to) out.push({ to: r.to, imp }); else if (r.ext) ext.add(r.ext); else bad.add(imp.spec);
      }
    } else {
      const results = a.specs.map((spec) => [spec, resolveLoose(spec, f, a.lang, loose, goModule)]);
      for (const [spec, r] of results) {
        if (r.to) for (const to of r.to) out.push({ to, imp: { spec, names: [] } });
        // `from a import b`: when a.b is a module, a was only its package, not an outside one.
        // A relative Python import that does not resolve is a name, never an outside package.
        else if (!(a.lang === 'python' && spec.startsWith('.')) && !results.some(([s, x]) => x.to && s.startsWith(`${spec}.`))) ext.add(r.ext);
      }
    }
    edges.set(f, out);
    for (const e of ext) external.set(e, (external.get(e) ?? 0) + 1);
    unresolved += bad.size;
    modules.push({ id: f, lang: a.lang === 'js' ? (posix.extname(f).slice(1) || 'js') : a.lang, lines: a.lines, imports: sorted(out.map((e) => e.to)), ext: sorted(ext), ...(bad.size ? { unresolved: sorted(bad).slice(0, 10) } : {}) });
  }

  // Shared helpers: exported functions and classes, followed through re-exports, used by 2+ files.
  const exportsOf = (f) => info.get(f)?.exports ?? null;
  function definer(file, name, seen = new Set()) {
    if (!info.has(file) || seen.has(file)) return null;
    seen.add(file);
    const a = info.get(file);
    if (a.lang !== 'js') return null;
    const own = a.exports.find((e) => e.name === name);
    if (own) return { file, exp: own };
    for (const { to, imp } of edges.get(file) ?? []) {
      if (!imp.reexport) continue;
      if (imp.reexport === '*') { const d = definer(to, name, seen); if (d) return d; } else {
        const pair = imp.reexport.find(([, as]) => as === name);
        if (pair) return definer(to, pair[0], seen);
      }
    }
    return null;
  }
  const uses = new Map(); // file#name → { file, name, line, kind, users:Set }
  for (const [f, list] of edges) {
    for (const { to, imp } of list) {
      if (imp.reexport) continue;
      for (const n of imp.names) {
        if (n === '*') continue;
        const d = definer(to, n);
        if (!d || !['function', 'class'].includes(d.exp.kind) || d.file === f) continue;
        const id = `${d.file}#${n}`;
        // A default export shows under its own name when it has one (export default function PageHeader).
        const name = n === 'default' ? (info.get(d.file).exports.find((x) => x.local === true && x.line === d.exp.line)?.name ?? n) : n;
        if (!uses.has(id)) uses.set(id, { id, file: d.file, name, line: d.exp.line, kind: d.exp.kind, users: new Set() });
        uses.get(id).users.add(f);
      }
    }
  }
  const helpers = [...uses.values()].filter((h) => h.users.size >= 2).map((h) => ({ id: h.id, file: h.file, name: h.name, line: h.line, kind: h.kind, usedBy: sorted(h.users) }));

  // Settings: env vars (plus the keys env templates declare) and settings/config keys.
  const settings = new Map();
  const setting = (id, kind) => { if (!settings.has(id)) settings.set(id, { id, kind, reads: new Set(), writes: new Set(), declared: new Set(), owners: new Set() }); return settings.get(id); };
  for (const [f, a] of info) {
    if (a.lang !== 'js') continue;
    for (const e of a.env) setting(`env:${e.key}`, 'env')[e.write ? 'writes' : 'reads'].add(`${f}:${e.line}`);
    for (const s of a.settings) { const r = setting(`key:${s.key}`, 'key'); r[s.write ? 'writes' : 'reads'].add(`${f}:${s.line}`); if (s.owner) r.owners.add(s.owner); }
  }
  for (const f of files.filter((x) => ENV_TEMPLATE.test(x))) {
    for (const m of (read(f) ?? '').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) setting(`env:${m[1]}`, 'env').declared.add(f); // names only, never values
  }
  const settingList = [...settings.values()].map((s) => ({ id: s.id, kind: s.kind, reads: sorted(s.reads), writes: sorted(s.writes), ...(s.declared.size ? { declared: sorted(s.declared) } : {}), ...(s.owners.size ? { owners: sorted(s.owners) } : {}) }));

  // Surfaces. Route prefixes come from register(plugin, { prefix }) / use('/p', router), chained.
  const mountedAt = new Map(); // file → [prefix]
  for (const [f, a] of info) {
    if (a.lang !== 'js') continue;
    for (const m of a.mounts) {
      const e = (edges.get(f) ?? []).find(({ imp }) => imp.locals && Object.hasOwn(imp.locals, m.ident));
      if (!e) continue;
      const name = e.imp.locals[m.ident];
      const to = (name !== '*' && definer(e.to, name)?.file) || e.to; // through a barrel to the file that defines it
      mountedAt.set(to, [...(mountedAt.get(to) ?? []), { prefix: m.prefix, by: f }]);
    }
  }
  const prefixes = (f, seen = new Set()) => {
    if (seen.has(f) || !mountedAt.has(f)) return [''];
    seen.add(f);
    return mountedAt.get(f).flatMap((m) => prefixes(m.by, seen).map((p) => `${p}${m.prefix}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')));
  };
  const behind = (f) => {
    const direct = sorted((edges.get(f) ?? []).filter(({ imp }) => !imp.type).map((e) => e.to));
    const svc = direct.filter((x) => SERVICE.test(x));
    return (svc.length ? svc : direct).slice(0, 20);
  };
  // A handler's services: the imported files whose bindings it names, directly
  // or through a function of the same file it calls (one step). File-wide
  // imports only when the handler names none (an inline plugin, say).
  const handled = (f, ids) => {
    const a = info.get(f);
    const names = new Set(ids);
    for (const id of ids) for (const x of a.uses?.get(id) ?? []) names.add(x);
    const hit = sorted((edges.get(f) ?? []).filter(({ imp }) => !imp.type && Object.keys(imp.locals ?? {}).some((l) => names.has(l))).map((e) => e.to));
    return hit.length ? hit.slice(0, 20) : behind(f);
  };
  const surfaces = [];
  for (const [f, a] of info) {
    if (a.lang !== 'js') continue;
    for (const r of a.routes) {
      for (const pre of [...new Set(prefixes(f))]) {
        const path = `${pre}${r.path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/';
        surfaces.push({ id: `route:${r.method} ${path} ${f}`, kind: 'route', method: r.method, path, file: f, line: r.line, services: handled(f, r.ids ?? []) });
      }
    }
  }
  for (const s of fileSurfaces(files.filter((f) => info.has(f)), exportsOf)) {
    surfaces.push({ id: `${s.kind}:${s.method ? `${s.method} ` : ''}${s.path} ${s.file}`, kind: s.kind, ...(s.method ? { method: s.method } : {}), path: s.path, file: s.file, line: 1, services: s.method && info.get(s.file).uses?.has(s.method) ? handled(s.file, [s.method]) : behind(s.file) });
  }
  // Screens reach routes through their client calls, up to two import steps deep.
  const byLast = new Map(); // routes by their last path segment
  for (const r of surfaces.filter((s) => s.kind === 'route')) { const k = segs(r.path).at(-1) ?? ''; if (!byLast.has(k)) byLast.set(k, []); byLast.get(k).push(r); }
  const memo = new Map(); // file → route ids its own calls reach
  const reached = (f) => {
    if (!memo.has(f)) {
      const hits = new Set();
      for (const c of info.get(f)?.calls ?? []) {
        const last = segs(c.path).at(-1) ?? '';
        for (const r of [...(byLast.get(last) ?? []), ...(last === ':' ? [] : byLast.get(':') ?? [])]) if ((c.method === r.method || r.method === 'ALL') && callMatches(c.path, r.path)) hits.add(r.id);
      }
      memo.set(f, hits);
    }
    return memo.get(f);
  };
  for (const s of surfaces.filter((x) => x.kind === 'screen')) {
    const one = (edges.get(s.file) ?? []).map((e) => e.to);
    const near = new Set([s.file, ...one, ...one.flatMap((f) => (edges.get(f) ?? []).map((e) => e.to))]);
    const hits = new Set([...near].flatMap((f) => [...reached(f)]));
    if (hits.size) s.calls = sorted(hits).slice(0, 30);
  }
  const { keys, sources, dirs } = catalogs(files, read);
  const used = new Map(); let missing = 0;
  for (const [f, a] of info) {
    if (a.lang !== 'js') continue;
    for (const m of a.msgs) {
      const k = [m.ns && `${m.ns}.${m.key}`, m.key, ...a.ns.map((n) => `${n}.${m.key}`)].find((x) => x && keys.has(x));
      if (!k) { missing++; continue; }
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(f);
    }
  }
  // Only keys code uses, or that miss a locale: the rest are counted (meta.messages), not listed.
  let unused = 0;
  for (const [k, v] of keys) {
    const by = sorted(used.get(k) ?? []);
    if (!by.length) unused++;
    if (by.length || v.missing.length) surfaces.push({ id: `message:${k}`, kind: 'message', usedBy: by, ...(v.missing.length ? { missing: v.missing } : {}) });
  }

  // Reuse candidates: function bodies with the same shape, in more than one place.
  const groups = new Map();
  for (const [f, a] of info) for (const fn of a.fns ?? []) { if (!groups.has(fn.hash)) groups.set(fn.hash, []); groups.get(fn.hash).push({ ...fn, file: f }); }
  const reuse = [...groups].filter(([, g]) => g.length >= 2).map(([hash, g]) => ({ id: hash, lines: Math.max(...g.map((x) => x.lines)), fns: sorted(g.map((x) => `${x.file}#${x.name}:${x.line}`)) }))
    .sort((a, b) => b.lines * b.fns.length - a.lines * a.fns.length).slice(0, 500);
  ms.link = now() - t2;
  ms.total = now() - t0;

  const langs = {};
  for (const m of modules) langs[m.lang] = (langs[m.lang] ?? 0) + 1;
  const head = gitHead(root);
  const meta = {
    root: basename(root), repo: inferRepo(root), commit: head.commit, pushed: head.pushed, files: files.length, scanned: info.size, partial, ms,
    langs, unresolved, messages: { keys: keys.size, unused, unknownLookups: missing, catalogs: dirs },
    external: [...external].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([name, n]) => `${name} ${n}`),
  };
  const once = [...new Map(surfaces.map((s) => [s.id, s])).values()]; // a route registered twice is one surface
  return { meta, modules: modules.sort(byId), helpers: helpers.sort(byId), settings: settingList.sort(byId), surfaces: once.sort(byId), reuse: reuse.sort(byId) };
}

export const COLLECTIONS = ['modules', 'helpers', 'settings', 'surfaces', 'reuse'];
