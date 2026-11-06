// The map's storage in the run's folder, `map/`:
//   events.jsonl  append-only. Each build writes map.build (its metadata),
//                 map.delta lines (records set or removed, per collection,
//                 ~12 KB each) and map.done (counts and a digest).
//   map.json      the snapshot, rebuilt from the events: stable key order,
//                 sorted arrays, one record per line, and `upTo` { seq, sha256 }
//                 of the events it applied.
// A reader that finds the snapshot behind, or its hash wrong, replays the
// events; a bad line, a seq gap or a replay that misses the digest fails loudly.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from '../store.mjs';
import { maskSecrets } from '../secrets.mjs';
import { COLLECTIONS } from './build.mjs';

export const V = 1;
const CHUNK = 12 * 1024;
export const files = (dir) => ({ events: join(dir, 'events.jsonl'), snapshot: join(dir, 'map.json') });

// Stable JSON: object keys sorted at every level.
export function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const digest = (snap) => sha(COLLECTIONS.map((c) => snap[c].map(canon).join('\n')).join('\n'));

// The schema of each kind, checked on write and on read.
const TYPES = { v: 'number', seq: 'number', at: 'string', kind: 'string', build: 'number' };
const KINDS = { 'map.build': { meta: 'object' }, 'map.delta': { coll: 'string', set: 'array', del: 'array' }, 'map.done': { stats: 'object', digest: 'string' } };
const typeOf = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);
export function validate(e, where = 'event') {
  const fail = (why) => { throw new Error(`map: invalid ${where}: ${why}`); };
  if (typeOf(e) !== 'object') fail('not an object');
  for (const [k, t] of Object.entries({ ...TYPES, ...(KINDS[e.kind] ?? {}) })) if (typeOf(e[k]) !== t) fail(`${k} must be a ${t}`);
  if (!KINDS[e.kind]) fail(`unknown kind ${e.kind}`);
  if (e.v !== V) fail(`schema version ${e.v}, expected ${V}`);
  if (e.unit !== undefined && typeof e.unit !== 'string') fail('unit must be a string');
  if (e.kind === 'map.delta') {
    if (!COLLECTIONS.includes(e.coll)) fail(`unknown collection ${e.coll}`);
    if (e.set.some((r) => typeOf(r) !== 'object' || typeof r.id !== 'string') || e.del.some((d) => typeof d !== 'string')) fail('records need a string id');
  }
  return e;
}

function readEvents(file) {
  if (!existsSync(file)) return { events: [], lines: [] };
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = lines.map((l, i) => {
    let e; try { e = JSON.parse(l); } catch { throw new Error(`map: ${file} line ${i + 1} is not JSON`); }
    validate(e, `event on line ${i + 1}`);
    if (e.seq !== i + 1) throw new Error(`map: ${file} line ${i + 1} has seq ${e.seq}: a gap or a reorder`);
    return e;
  });
  return { events, lines };
}
const prefixHash = (lines, n) => sha(lines.slice(0, n).map((l) => `${l}\n`).join(''));

const empty = () => ({ v: V, upTo: { seq: 0, sha256: sha('') }, build: null, ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])) });

// Applies events after the snapshot's seq; checks each finished build's digest.
function replay(snap, events) {
  const colls = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map(snap[c].map((r) => [r.id, r]))]));
  let build = snap.build; let pending = null;
  for (const e of events) {
    if (e.kind === 'map.build') pending = { n: e.build, at: e.at, ...(e.unit ? { unit: e.unit } : {}), ...e.meta };
    else if (e.kind === 'map.delta') { const m = colls[e.coll]; for (const id of e.del) m.delete(id); for (const r of e.set) m.set(r.id, r); } else {
      const out = { ...Object.fromEntries(COLLECTIONS.map((c) => [c, [...colls[c].values()].sort((a, b) => (a.id < b.id ? -1 : 1))])) };
      if (digest(out) !== e.digest) throw new Error(`map: build ${e.build} does not reproduce from the events (digest mismatch at seq ${e.seq})`);
      build = { ...pending, stats: e.stats, digest: e.digest };
    }
  }
  return { ...snap, build, ...Object.fromEntries(COLLECTIONS.map((c) => [c, [...colls[c].values()].sort((a, b) => (a.id < b.id ? -1 : 1))])) };
}

export function serialise(s) {
  const body = [`"v":${s.v}`, `"upTo":${canon(s.upTo)}`, `"build":${canon(s.build)}`,
    ...COLLECTIONS.map((c) => `"${c}":[${s[c].length ? `\n${s[c].map(canon).join(',\n')}\n` : ''}]`)];
  return `{${body.join(',\n')}}\n`;
}

// The current snapshot: trusted when it matches the events, else replayed (and rewritten).
export function load(dir, { write = true } = {}) {
  const f = files(dir);
  const { events, lines } = readEvents(f.events);
  let snap = null;
  if (existsSync(f.snapshot)) {
    try {
      const s = JSON.parse(readFileSync(f.snapshot, 'utf8'));
      if (s.v === V && s.upTo && s.upTo.seq <= events.length && prefixHash(lines, s.upTo.seq) === s.upTo.sha256 && COLLECTIONS.every((c) => Array.isArray(s[c]))) snap = s;
    } catch { /* unreadable: replay */ }
  }
  const from = snap?.upTo.seq ?? 0;
  if (snap && from === events.length) return snap;
  const out = replay(snap ?? empty(), events.slice(from));
  out.upTo = { seq: events.length, sha256: prefixHash(lines, events.length) };
  if (write && events.length) writeAtomic(f.snapshot, serialise(out));
  return out;
}

// Records one build: appends its events and rewrites the snapshot, under one lock.
// Every string is masked before it is recorded, so the digest covers what any copy holds
// (push masks again; for map data that is then a no-op, and a pulled log replays cleanly).
const masked = (v) => (typeof v === 'string' ? maskSecrets(v) : Array.isArray(v) ? v.map(masked) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, masked(x)])) : v);

export function record(dir, raw, { unit = null, at = new Date().toISOString() } = {}) {
  const built = masked(raw);
  const f = files(dir);
  return withLock(f.events, () => {
    const prev = load(dir, { write: false });
    const n = (prev.build?.n ?? 0) + 1;
    let seq = prev.upTo.seq;
    const out = [];
    const push = (e) => { out.push(validate({ v: V, seq: ++seq, at, kind: e.kind, ...(unit ? { unit } : {}), build: n, ...e })); };
    push({ kind: 'map.build', meta: built.meta });
    const stats = {};
    for (const c of COLLECTIONS) {
      stats[c] = built[c].length;
      const old = new Map(prev[c].map((r) => [r.id, canon(r)]));
      const now = new Set(built[c].map((r) => r.id));
      const set = built[c].filter((r) => old.get(r.id) !== canon(r));
      const del = built.meta.partial ? [] : [...old.keys()].filter((id) => !now.has(id)); // a partial build never removes
      let chunk = { set: [], del: [] }; let size = 0;
      const flush = () => { if (chunk.set.length || chunk.del.length) push({ kind: 'map.delta', coll: c, ...chunk }); chunk = { set: [], del: [] }; size = 0; };
      for (const id of del) { chunk.del.push(id); size += id.length + 3; if (size > CHUNK) flush(); }
      for (const r of set) { chunk.set.push(r); size += canon(r).length; if (size > CHUNK) flush(); }
      flush();
    }
    const next = replay(prev, out); // the build and its deltas: what the done line must match
    push({ kind: 'map.done', stats, digest: digest(next) });
    const text = out.map((e) => JSON.stringify(e)).join('\n');
    appendFileSync(f.events, `${text}\n`);
    return load(dir);
  });
}
