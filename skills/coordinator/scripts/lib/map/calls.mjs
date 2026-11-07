// Function-level calls for JS/TS. Every file is read at one commit (the unit's
// head, else HEAD) so the data and its links agree; git's blob ids key the scan
// cache (map/calls-cache.json), so a rebuild rescans only changed blobs. Per
// unit: the functions its diff touched, what they call and what calls them,
// one level each way plus a second. Read-only on the project; never runs its code.
//   calls-git.mjs   git reads: commits, trees, blobs, diff ranges
//   calls-link.mjs  the index: calls resolved across files, callers
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../store.mjs';
import { JS, keepFile, listFiles } from './files.mjs';
import { blobId, blobs, commitOf, diffRanges, treeOf } from './calls-git.mjs';
import { link } from './calls-link.mjs';
import { JSX_FILE, SCAN_VERSION, scanFns, validScan } from './fns.mjs';
import { TEST } from './js.mjs';

export { link };
export const LIST = 30; // per list on a unit, one level
export const MORE = 8; // per entry, the second level
const TOUCHED = 40;
const MAX_BYTES = 1024 * 1024;
const CONFIG = /(^|\/)(package\.json|[jt]sconfig[^/]*\.json)$/;
const short = (s) => String(s).slice(0, 12);

// Every JS/TS file scanned, at `commit` (a full sha) or, with none, in the working tree.
// `first` (the unit's changed files) is scanned before the rest and whatever the time cap says;
// past `deadline`, other uncached files are skipped and the result is partial.
export function scanAll(root, { commit = null, cacheFile = null, deadline = Infinity, first = [] } = {}) {
  const tree = commit ? treeOf(root, commit) : null;
  const files = tree ? [...tree.keys()].filter(keepFile).sort() : listFiles(root, { deadline: Math.max(deadline, Date.now() + 10_000) }).files;
  let cache = {};
  if (cacheFile && existsSync(cacheFile)) { try { const c = JSON.parse(readFileSync(cacheFile, 'utf8')); if (c.v === SCAN_VERSION && c.blobs && typeof c.blobs === 'object') cache = c.blobs; } catch { /* rebuilt */ } }
  const firstSet = new Set(first);
  const js = files.filter((f) => JS.test(f)).sort((a, b) => (firstSet.has(b) - firstSet.has(a)) || (a < b ? -1 : 1));
  const disk = (f) => { try { const p = join(root, f); return statSync(p).size > MAX_BYTES ? null : readFileSync(p); } catch { return null; } };
  const scans = new Map(); const next = {}; let partial = false; let fresh = 0;
  const key = (f, id) => `${id}${JSX_FILE.test(f) ? ':jsx' : ''}`;
  const take = (f, k, text) => {
    if (text === null || text.length > MAX_BYTES || /^[^\n]{5000,}/.test(text)) return; // too big, or minified
    if (Date.now() > deadline && !firstSet.has(f)) { partial = true; return; }
    const s = scanFns(text, f); fresh++;
    scans.set(f, s); next[k] = s;
  };
  const misses = [];
  for (const f of js) {
    let id = tree?.get(f); let buf = null;
    if (!tree) { buf = disk(f); if (!buf) continue; id = blobId(buf); }
    const k = key(f, id);
    if (validScan(cache[k])) { scans.set(f, cache[k]); next[k] = cache[k]; continue; } // a broken entry is rescanned
    if (tree) misses.push([f, k, id]); else take(f, k, buf.toString('utf8'));
  }
  const now1 = misses.filter((m) => firstSet.has(m[0])); const later = misses.filter((m) => !firstSet.has(m[0]));
  blobs(root, now1.map((m) => m[2])).forEach((text, j) => take(now1[j][0], now1[j][1], text));
  misses.splice(0, misses.length, ...later);
  let read = 0;
  for (; read < misses.length && Date.now() <= deadline; read += 200) {
    const part = misses.slice(read, read + 200);
    blobs(root, part.map((m) => m[2])).forEach((text, j) => take(part[j][0], part[j][1], text));
  }
  if (read < misses.length) partial = true;
  if (cacheFile && (fresh || Object.keys(next).length !== Object.keys(cache).length)) writeAtomic(cacheFile, JSON.stringify({ v: SCAN_VERSION, blobs: next }));
  // Config files for the resolver, from the same version.
  const cfg = files.filter((f) => CONFIG.test(f));
  const texts = new Map(tree ? blobs(root, cfg.map((f) => tree.get(f))).map((t, i) => [cfg[i], t]) : cfg.map((f) => [f, disk(f)?.toString('utf8') ?? null]));
  return { files, scans, partial, fresh, read: (f) => texts.get(f) ?? null };
}

const brief = (fns, id) => { const f = fns.get(id); return f ? { id, file: f.file, q: f.q, line: f.line, ...(f.kind ? { kind: f.kind } : {}) } : { id }; };

// Which commit to read, and what the unit changed: its diff, or whole files.
function plan(root, { base, head, files, fallbackFiles }) {
  const js = (list) => new Map(list.filter((f) => JS.test(f) && keepFile(f)).map((f) => [f, null]));
  const b = base && head ? commitOf(root, base) : null; const h = base && head ? commitOf(root, head) : null;
  if (b && h) return { commit: h, base: b, head: h, source: 'diff', changes: diffRanges(root, b, h, (f) => JS.test(f) && keepFile(f)) };
  const now = commitOf(root, 'HEAD');
  const where = now ? `HEAD ${short(now)}` : 'the working tree (not a git repository)';
  if (base && head) {
    const list = files.length ? files : fallbackFiles;
    return { commit: now, base, head, source: list.length ? 'files' : 'diff', changes: js(list), note: `The unit's commits ${short(base)}…${short(head)} are not in this repository (deleted, or never fetched here), so its diff cannot be read. Shown: ${list.length ? 'the files it changed, ' : 'nothing, '}read at ${where}; their lines may differ from the unit's version.` };
  }
  return { commit: now, source: 'files', changes: js(files), ...(now ? {} : { note: `Read from ${where}; no links.` }) };
}

// One unit's functions, as plain JSON for map/calls/<unit>.json.
export function unitCalls(root, { unit, base = null, head = null, files = [], fallbackFiles = [], source = null, cacheFile = null, deadline = Infinity, now = new Date().toISOString() }) {
  const p = plan(root, { base, head, files, fallbackFiles });
  const all = scanAll(root, { commit: p.commit, cacheFile, deadline, first: [...p.changes.keys()] });
  const { fns, callers } = link(all);
  const touched = []; let outside = 0;
  for (const [file, ranges] of p.changes) {
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
  const uniq = (list, k) => { const seen = new Set(); return list.filter((x) => { const v = k(x); if (seen.has(v)) return false; seen.add(v); return true; }); };
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
  const order = (id) => `${testy(id)}${id.split('#')[0]}#${String(fns.get(id).line).padStart(7, '0')}`;
  const list = touched.sort((a, b) => (order(a) < order(b) ? -1 : 1)).slice(0, TOUCHED);
  return {
    v: 1, unit, at: now, ...(p.base ? { base: p.base, head: p.head } : {}), ref: p.commit, ...(p.note ? { note: p.note } : {}), source: source && p.source !== 'diff' ? source : p.source,
    files: [...p.changes.keys()].sort(), outside, partial: all.partial, functions: fns.size,
    touched: list.map(entry), touchedTotal: touched.length,
  };
}

// Plain lines for a brief or the terminal.
export function callsText(r) {
  if (!r) return '';
  const out = [`Functions unit ${r.unit} touched (${r.source}${r.head && !r.note ? ` ${short(r.base).slice(0, 8)}...${short(r.head).slice(0, 8)}` : ''}): ${r.touchedTotal}${r.touchedTotal > r.touched.length ? `, first ${r.touched.length}` : ''}`];
  if (r.note) out.push(`Note: ${r.note}`);
  const name = (x) => (x.id ? `${x.q} (${x.file}:${x.at ?? x.line})` : x.n);
  for (const t of r.touched) {
    out.push(`- ${t.q} ${t.file}:${t.line}-${t.end}`);
    const calls = t.calls.filter((c) => c.id);
    if (calls.length) out.push(`  calls: ${calls.slice(0, 10).map((c) => `${c.q} (${c.file}:${c.line})`).join(', ')}${t.unresolved ? `; ${t.unresolved} unresolved` : ''}`);
    else if (t.unresolved) out.push(`  calls: ${t.unresolved} unresolved (outside packages, globals, or dynamic)`);
    out.push(t.callers.length ? `  called by: ${t.callers.slice(0, 10).map(name).join(', ')}${t.callersTotal > 10 ? `, … ${t.callersTotal - 10} more` : ''}` : '  called by: nothing found (an entry point, or called through a decorator, a callback or a dynamic call)');
  }
  if (r.outside) out.push(`${r.outside} changed lines sit outside any function (imports, top-level code, types).`);
  return `${out.join('\n')}\n`;
}
