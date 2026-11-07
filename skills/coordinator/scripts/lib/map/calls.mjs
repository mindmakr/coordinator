// Function-level calls for JS/TS: an index of every function and method with
// the calls in its body resolved through imports (lib/map/fns.mjs scans one
// file; the scans are cached by file hash in map/calls-cache.json, so a
// rebuild rescans only changed files), and per unit, the functions its diff
// touched with what they call and what calls them, one level each way plus
// a second. Read-only on the project; never runs its code.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../store.mjs';
import { JS, listFiles } from './files.mjs';
import { SCAN_VERSION, scanFns } from './fns.mjs';
import { TEST } from './js.mjs';
import { resolver } from './resolve.mjs';

const MAX_BYTES = 1024 * 1024;
export const LIST = 30; // per list on a unit, one level
export const MORE = 8; // per entry, the second level
const TOUCHED = 40;
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// Every JS/TS file scanned (from the cache when its hash is unchanged), until `deadline`.
// `overrides`: file → source text to use instead of the working tree (a unit's head).
export function scanAll(root, { cacheFile = null, deadline = Infinity, overrides = new Map() } = {}) {
  const files = listFiles(root, Math.max(deadline, Date.now() + 10_000)); // the walk has its own cap; the scan keeps the deadline
  for (const f of overrides.keys()) if (!files.includes(f)) files.push(f);
  let cache = { v: SCAN_VERSION, files: {} };
  if (cacheFile && existsSync(cacheFile)) { try { const c = JSON.parse(readFileSync(cacheFile, 'utf8')); if (c.v === SCAN_VERSION && c.files) cache = c; } catch { /* rebuilt */ } }
  const scans = new Map(); let partial = false; let fresh = 0; const next = {};
  for (const f of files) {
    if (!JS.test(f)) continue;
    let src = overrides.get(f) ?? null;
    if (src === null) { try { const p = join(root, f); if (statSync(p).size > MAX_BYTES) continue; src = readFileSync(p, 'utf8'); } catch { continue; } }
    if (/^[^\n]{5000,}/.test(src)) continue; // minified
    const h = sha1(src);
    const hit = cache.files[f];
    if (overrides.has(f) && hit) next[f] = hit; // the working tree's scan stays cached; the override is used once
    if (hit && hit.h === h) { scans.set(f, hit.s); next[f] = hit; continue; }
    if (Date.now() > deadline) { partial = true; continue; }
    const s = scanFns(src);
    scans.set(f, s); fresh++;
    if (!overrides.has(f)) next[f] = { h, s };
  }
  if (cacheFile && (fresh || Object.keys(next).length !== Object.keys(cache.files).length)) writeAtomic(cacheFile, JSON.stringify({ v: SCAN_VERSION, files: next }));
  return { files, scans, partial, fresh };
}

// The index: id (`file#Class.method`, `file#name`, `file#outer>inner`) → function, with calls resolved.
export function link(root, { files, scans }) {
  const read = (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return null; } };
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
    byFile.set(file, { qs, classes, imports: new Map(), byName, scanQ: new Map(s.fns.map((f) => [f.q, f])), owners: new Set(s.fns.map((f) => f.q.split('.')[0])) });
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
    // Parameters and locals of this function and the ones around it hide same-named functions and imports.
    const shadowed = new Set([...chain].flatMap((q) => b.scanQ.get(q)?.shadow ?? []));
    const local = (n) => {
      const c = b.byName.get(n) ?? [];
      const nested = c.filter((f) => (f.parent ? chain.has(f.parent) : false)).sort((x, y) => y.q.length - x.q.length)[0];
      if (nested) return b.qs.get(nested.q);
      if (shadowed.has(n)) return false;
      const top = c.find((f) => !f.parent);
      return top ? b.qs.get(top.q) : null;
    };
    const seen = new Set();
    for (const c of fn.raw) {
      let to = null; let ext = null;
      const r = c.r ?? null;
      if (c.k === 'new') { const k = classAt(fn.file, c.n); to = k ? (method(k.file, k.cls, 'constructor') ?? byFile.get(k.file).qs.get(k.cls)) : null; ext = !k ? b.imports.get(c.n)?.ext ?? null : null; } else if (r === null) {
        to = local(c.n);
        if (to === false && b.imports.get(c.n)?.bound) to = null; // `const { f } = await import('./x')` binds f itself
        if (to === false) to = null; else if (!to) { const im = b.imports.get(c.n); if (im?.to) to = im.name === '*' ? fnExported(im.to, 'default') : fnExported(im.to, im.name); else if (im) ext = im.ext; }
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
        const hidden = shadowed.has(r) && !b.imports.get(r)?.bound;
        const im = hidden ? null : b.imports.get(r);
        if (hidden) { const k = s.types[r] && classAt(fn.file, s.types[r]); if (k) to = method(k.file, k.cls, c.n); } else if (im?.to) to = im.name === '*' ? fnExported(im.to, c.n) : fnExported(im.to, im.name, c.n);
        else if (im) ext = im.ext;
        else if (b.classes.has(r)) to = method(fn.file, r, c.n);
        else if (b.qs.has(`${r}.${c.n}`)) to = b.qs.get(`${r}.${c.n}`);
        else if (s.types[r]) { const k = classAt(fn.file, s.types[r]); if (k) to = method(k.file, k.cls, c.n); else ext = b.imports.get(s.types[r])?.ext ?? null; }
      }
      if (to === fn.id && c.k === 'ref') continue;
      if (c.k === 'ref' && !to) continue; // a passed name that is not a known function: a value
      const n = r ? `${r === '?' ? '…' : r.startsWith('new ') ? `${r}()` : r}.${c.n}` : c.k === 'new' ? `new ${c.n}` : c.n;
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

// The lines each JS/TS file gained or changed between two commits: file → [[from, to]] in the head's numbering.
export function diffRanges(root, base, head) {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--unified=0', '-M', `${base}...${head}`, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  const files = new Map(); let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) { const p = line.slice(4).trim(); cur = p === '/dev/null' ? null : p.replace(/^b\//, ''); if (cur && JS.test(cur)) files.set(cur, []); else cur = null; continue; }
    const h = cur && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { const a = Number(h[1]); const n = h[2] === undefined ? 1 : Number(h[2]); files.get(cur).push(n ? [a, a + n - 1] : [a, a]); }
  }
  return files;
}

// Files at a commit, in one git call: file → text (absent when the commit lacks it).
function showAll(root, head, files) {
  const out = new Map();
  if (!files.length) return out;
  let buf;
  try { buf = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: files.map((f) => `${head}:${f}\n`).join(''), maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return out; }
  let at = 0;
  for (const f of files) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head1 = buf.toString('utf8', at, nl).split(' ');
    at = nl + 1;
    if (head1[1] !== 'blob') continue; // "<spec> missing"
    const size = Number(head1[2]);
    out.set(f, buf.toString('utf8', at, at + size));
    at += size + 1;
  }
  return out;
}
const brief = (fns, id) => { const f = fns.get(id); return f ? { id, file: f.file, q: f.q, line: f.line, ...(f.kind ? { kind: f.kind } : {}) } : { id }; };

// One unit's functions: from its diff (base...head, the head's text), or whole files when only those are known.
// Returns plain JSON for map/calls/<unit>.json.
export function unitCalls(root, { unit, base = null, head = null, files = [], source = null, ref = null, cacheFile = null, deadline = Infinity, now = new Date().toISOString() }) {
  let changes; const overrides = new Map();
  if (base && head) {
    changes = diffRanges(root, base, head);
    const texts = showAll(root, head, [...changes.keys()]);
    for (const f of changes.keys()) { if (texts.has(f)) overrides.set(f, texts.get(f)); else changes.delete(f); }
  } else changes = new Map(files.filter((f) => JS.test(f)).map((f) => [f, null]));
  const all = scanAll(root, { cacheFile, deadline, overrides });
  const { fns, callers } = link(root, all);
  const touched = []; let outside = 0;
  for (const [file, ranges] of changes) {
    const scan = all.scans.get(file);
    if (!scan) continue;
    const ids = new Set();
    if (ranges === null) { for (const f of scan.fns) if (!f.parent) ids.add(`${file}#${f.q}`); } else {
      for (const [a, b] of ranges) {
        for (let l = a; l <= b; l++) {
          const inner = scan.fns.filter((f) => f.line <= l && l <= f.end).sort((x, y) => y.line - x.line || x.end - y.end)[0];
          if (inner) ids.add(`${file}#${inner.q}`); else outside++;
        }
      }
    }
    for (const id of ids) if (fns.has(id)) touched.push(id);
  }
  // One entry per function called or calling (its first call site), resolved before unresolved.
  const uniq = (list, key) => { const seen = new Set(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const out = (id) => uniq(fns.get(id)?.calls ?? [], (c) => c.to ?? `?${c.n}`);
  const testy = (id) => (TEST.test(id.split('#')[0]) ? 1 : 0);
  const into = (id) => uniq(callers.get(id) ?? [], (c) => c.from).sort((x, y) => testy(x.from) - testy(y.from)); // product code first
  const entry = (id) => {
    const f = fns.get(id);
    const calls = out(id); const by = into(id);
    const known = calls.filter((c) => c.to); const unknown = calls.filter((c) => !c.to);
    return {
      ...brief(fns, id), end: f.end,
      calls: [
        ...known.slice(0, LIST).map((c) => ({ n: c.n, at: c.line, ...(c.k ? { k: c.k } : {}), ...brief(fns, c.to), more: out(c.to).filter((x) => x.to).slice(0, MORE).map((x) => ({ n: x.n, at: x.line, ...brief(fns, x.to), ...(x.k ? { k: x.k } : {}) })) })),
        ...unknown.slice(0, LIST).map((c) => ({ n: c.n, at: c.line, ...(c.ext ? { ext: c.ext } : {}) })),
      ],
      callsTotal: calls.length, unresolved: unknown.length,
      callers: by.slice(0, LIST).map((c) => ({ ...brief(fns, c.from), at: c.line, ...(c.k ? { k: c.k } : {}), more: into(c.from).slice(0, MORE).map((x) => ({ ...brief(fns, x.from), at: x.line, ...(x.k ? { k: x.k } : {}) })) })),
      callersTotal: by.length,
    };
  };
  // Product code first, tests after; then by file and line.
  const order = (id) => `${TEST.test(id.split('#')[0]) ? 1 : 0}${id.split('#')[0]}#${String(fns.get(id).line).padStart(7, '0')}`;
  const list = touched.sort((a, b) => (order(a) < order(b) ? -1 : 1)).slice(0, TOUCHED);
  return {
    v: 1, unit, at: now, ...(base && head ? { base, head } : {}), ref: head ?? ref, source: source ?? (base && head ? 'diff' : 'files'),
    files: [...changes.keys()].sort(), outside, partial: all.partial, functions: fns.size,
    touched: list.map(entry), touchedTotal: touched.length,
  };
}

// Plain lines for a brief or the terminal.
export function callsText(r) {
  if (!r) return '';
  const out = [`Functions unit ${r.unit} touched (${r.source}${r.head ? ` ${r.base.slice(0, 8)}...${r.head.slice(0, 8)}` : ''}): ${r.touchedTotal}${r.touchedTotal > r.touched.length ? `, first ${r.touched.length}` : ''}`];
  const name = (x) => (x.id ? `${x.q} (${x.file}:${x.line})` : x.n);
  for (const t of r.touched) {
    out.push(`- ${t.q} ${t.file}:${t.line}-${t.end}`);
    const calls = t.calls.filter((c) => c.id);
    if (calls.length) out.push(`  calls: ${calls.slice(0, 10).map(name).join(', ')}${t.unresolved ? `; ${t.unresolved} unresolved` : ''}`);
    else if (t.unresolved) out.push(`  calls: ${t.unresolved} unresolved (outside packages, globals, or dynamic)`);
    out.push(t.callers.length ? `  called by: ${t.callers.slice(0, 10).map(name).join(', ')}${t.callersTotal > 10 ? `, … ${t.callersTotal - 10} more` : ''}` : '  called by: nothing found (an entry point, a callback, or called dynamically)');
  }
  if (r.outside) out.push(`${r.outside} changed lines sit outside any function (imports, top-level code, types).`);
  return `${out.join('\n')}\n`;
}
