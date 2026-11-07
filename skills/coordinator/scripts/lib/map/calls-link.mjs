// The call index for JS/TS (lib/map/calls.mjs builds it from the scans of
// lib/map/fns.mjs): every function, method and class by id (`file#Class.method`,
// `file#name`, `file#outer>inner`), its calls resolved through imports,
// re-exports, `this`, typed fields and locals, and who calls each one.
import { resolver } from './resolve.mjs';

// The index: id (`file#Class.method`, `file#name`, `file#outer>inner`) → function, with calls resolved.
// `read` gives a config file's text (package.json, tsconfig) from the same version as the scans.
export function link({ files, scans, read }) {
  const resolve = resolver(files, read);
  const fns = new Map(); // id → record
  const byFile = new Map(); // file → { q → id, classes → Map(name → class) }
  for (const [file, s] of scans) {
    const qs = new Map(); const classes = new Map(s.classes.map((c) => [c.name, c]));
    for (const f of s.fns) { const id = `${file}#${f.q}`; qs.set(f.q, id); fns.set(id, { id, file, q: f.q, name: f.name, line: f.line, end: f.end, ...(f.cls ? { cls: f.cls } : {}), ...(f.parent ? { parent: f.parent } : {}), raw: f.calls, calls: [] }); }
    for (const c of s.classes) if (!qs.has(c.name)) { const id = `${file}#${c.name}`; qs.set(c.name, id); fns.set(id, { id, file, q: c.name, name: c.name, line: c.line, end: c.line, kind: 'class', raw: [], calls: [] }); }
    if (s.top.length) { const id = `${file}#(top)`; fns.set(id, { id, file, q: '(top)', name: '(top level)', line: 1, end: 1, kind: 'top', raw: s.top, calls: [] }); }
    // Plain functions by name (not methods: `Class.m`, `obj.m`), and every scanned function by its qualified name.
    const byName = new Map();
    for (const f of s.fns) if (!f.cls && !f.q.split('>').pop().includes('.')) { if (!byName.has(f.name)) byName.set(f.name, []); byName.get(f.name).push(f); }
    byFile.set(file, { qs, classes, imports: new Map(), byName, owners: new Set(s.fns.map((f) => f.q.split('.')[0])) });
  }
  // Import locals → { to | ext, name }.
  for (const [file, s] of scans) {
    const im = byFile.get(file).imports;
    for (const i of s.imports) {
      const r = resolve(i.spec, file);
      for (const [local, name] of Object.entries(i.locals)) im.set(local, { ...(r.to ? { to: r.to } : { ext: r.ext ?? i.spec }), name, ...(i.bound ? { bound: true } : {}) });
    }
  }
  // Where `name`, exported by `file`, is defined: { file, local }, through re-exports and import-then-export.
  const exported = (file, name, depth = 0) => {
    const s = scans.get(file);
    if (!s || depth > 8) return null;
    const local = s.exports[name];
    if (local !== undefined) {
      const l = local || name;
      const b = byFile.get(file);
      if (!b.qs.has(l) && !b.classes.has(l) && !b.owners.has(l)) {
        const im = b.imports.get(l);
        if (im?.to) return im.name === '*' ? { file: im.to, local: '*' } : exported(im.to, im.name, depth + 1);
      }
      return { file, local: local === '' ? '' : l };
    }
    for (const i of s.imports) {
      if (!i.reexport) continue;
      const r = resolve(i.spec, file);
      if (!r.to) continue;
      if (i.reexport === '*') { if (name === 'default') continue; const d = exported(r.to, name, depth + 1); if (d) return d; } else {
        const pair = i.reexport.find(([, as]) => as === name);
        if (pair) return pair[0] === '*' ? { file: r.to, local: '*' } : exported(r.to, pair[0], depth + 1);
      }
    }
    return null;
  };
  // A class named `name` as seen from `file`: { file, cls }.
  const classAt = (file, name) => {
    const b = byFile.get(file);
    if (!b || !name) return null;
    if (b.classes.has(name)) return { file, cls: name };
    const im = b.imports.get(name);
    if (!im?.to || im.name === '*') return null;
    const d = exported(im.to, im.name);
    return d && byFile.get(d.file)?.classes.has(d.local) ? { file: d.file, cls: d.local } : null;
  };
  const method = (file, cls, n, depth = 0) => {
    const b = byFile.get(file);
    if (!b || depth > 4) return null;
    const id = b.qs.get(`${cls}.${n}`);
    if (id) return id;
    const ext = b.classes.get(cls)?.ext;
    const up = ext && classAt(file, ext.split('.').pop());
    return up ? method(up.file, up.cls, n, depth + 1) : null;
  };
  // A top-level function (or an object's method) that `file` exports as `name`.
  const fnExported = (file, name, member = null) => {
    const d = exported(file, name);
    if (!d) return null;
    const b = byFile.get(d.file);
    if (d.local === '*') return member ? fnExported(d.file, member) : null;
    if (member === null) return b.qs.get(d.local) ?? null;
    if (b.classes.has(d.local)) return method(d.file, d.local, member);
    const own = b.qs.get(d.local ? `${d.local}.${member}` : member);
    if (own) return own;
    // An exported instance: `export const events = new EventsService()`.
    const type = d.local && scans.get(d.file).types[d.local];
    const k = type && classAt(d.file, type);
    return k ? method(k.file, k.cls, member) : null;
  };
  for (const fn of fns.values()) {
    const b = byFile.get(fn.file); const s = scans.get(fn.file);
    const chain = new Set(); // this function and its parents, for nested names
    for (let q = fn.q; q; q = q.includes('>') ? q.slice(0, q.lastIndexOf('>')) : null) chain.add(q);
    // A nested function in scope wins; then a local value (c.sh) hides the file's functions and imports.
    const local = (n, sh) => {
      const c = b.byName.get(n) ?? [];
      const nested = c.filter((f) => (f.parent ? chain.has(f.parent) : false)).sort((x, y) => y.q.length - x.q.length)[0];
      if (nested) return b.qs.get(nested.q);
      if (sh) return false;
      const top = c.find((f) => !f.parent);
      return top ? b.qs.get(top.q) : null;
    };
    const seen = new Set();
    for (const c of fn.raw) {
      let to = null; let ext = null;
      const r = c.r ?? null;
      if (c.k === 'new') { const k = classAt(fn.file, c.n); to = k ? (method(k.file, k.cls, 'constructor') ?? byFile.get(k.file).qs.get(k.cls)) : null; ext = !k ? b.imports.get(c.n)?.ext ?? null : null; } else if (r === null) {
        to = local(c.n, c.sh);
        if (to === false) to = null; else if (!to) {
          const im = b.imports.get(c.n);
          if (im?.to) to = im.name === '*' ? fnExported(im.to, 'default') : fnExported(im.to, im.name); else if (im) ext = im.ext;
          if (!to && c.k === 'jsx') { const k = classAt(fn.file, c.n); if (k) to = byFile.get(k.file).qs.get(k.cls); } // a class component
        }
      } else if (r === 'this' || r === 'super') {
        const cls = fn.cls ?? (fn.parent ? fns.get(`${fn.file}#${fn.parent.split('>')[0]}`)?.cls : null);
        if (cls) { if (r === 'this') to = method(fn.file, cls, c.n); else { const ex = b.classes.get(cls)?.ext; const up = ex && classAt(fn.file, ex.split('.').pop()); to = up ? method(up.file, up.cls, c.n) : null; } }
      } else if (/^this\.#?[\w$]+$/.test(r)) {
        const cls = fn.cls ?? (fn.parent ? fns.get(`${fn.file}#${fn.parent.split('>')[0]}`)?.cls : null);
        const type = cls && b.classes.get(cls)?.fields?.[r.slice(5)];
        const k = type && classAt(fn.file, type);
        if (k) to = method(k.file, k.cls, c.n); else if (type) ext = b.imports.get(type)?.ext ?? null;
      } else if (r.startsWith('new ')) {
        const k = classAt(fn.file, r.slice(4));
        if (k) to = method(k.file, k.cls, c.n);
      } else if (/^[\w$]+$/.test(r)) {
        const hidden = !!c.sh;
        const im = hidden ? null : b.imports.get(r);
        if (hidden) { const k = s.types[r] && classAt(fn.file, s.types[r]); if (k) to = method(k.file, k.cls, c.n); } else if (im?.to) to = im.name === '*' ? fnExported(im.to, c.n) : fnExported(im.to, im.name, c.n);
        else if (im) ext = im.ext;
        else if (b.classes.has(r)) to = method(fn.file, r, c.n);
        else if (b.qs.has(`${r}.${c.n}`)) to = b.qs.get(`${r}.${c.n}`);
        else if (s.types[r]) { const k = classAt(fn.file, s.types[r]); if (k) to = method(k.file, k.cls, c.n); else ext = b.imports.get(s.types[r])?.ext ?? null; }
      }
      if (to === fn.id && c.k === 'ref') continue;
      if (c.k === 'ref' && !to) continue; // a passed name that is not a known function: a value
      const plain = r ? `${r === '?' ? '…' : r.startsWith('new ') ? `${r}()` : r}.${c.n}` : c.k === 'new' ? `new ${c.n}` : c.n;
      const n = c.k === 'jsx' ? `<${plain}>` : plain;
      const key = `${to ?? n}@${c.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fn.calls.push({ ...(to ? { to } : {}), n, line: c.line, ...(c.k ? { k: c.k } : {}), ...(ext ? { ext } : {}) });
    }
    delete fn.raw;
  }
  const callers = new Map();
  for (const fn of fns.values()) for (const c of fn.calls) if (c.to && c.to !== fn.id) { if (!callers.has(c.to)) callers.set(c.to, []); callers.get(c.to).push({ from: fn.id, line: c.line, ...(c.k ? { k: c.k } : {}) }); }
  return { fns, callers };
}
