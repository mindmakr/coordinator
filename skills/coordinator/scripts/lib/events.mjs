// A run is its event log: events.jsonl, one JSON line per change, append only.
// state.json is a snapshot derived from it, with the last seq it applied and a
// SHA-256 of the log up to that line. A reader that finds the log ahead of the
// snapshot, or a hash that does not match, rebuilds the state from the events.
// The format is in references/durability.md.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V, validRun, validSnapshot, validateEvent } from './eventschema.mjs';
import { withLock, writeAtomic } from './store.mjs';

export const EVENTS = 'events.jsonl';
export const STATE = 'state.json';
const META = 'snapshot';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

// Numbers inside ids compare as numbers: B2 before B10, u9 before u10.
function natural(a, b) {
  const x = a.match(/\d+|\D+/g) ?? []; const y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const dx = /^\d/.test(x[i]); const dy = /^\d/.test(y[i]);
    if (dx && dy) { const p = x[i].replace(/^0+/, ''); const q = y[i].replace(/^0+/, ''); if (p.length !== q.length) return p.length - q.length; }
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

function sortDeep(v) {
  if (Array.isArray(v)) {
    const out = v.map(sortDeep);
    const keyed = out.length > 1 && out.every((x) => isObj(x) && typeof x.id === 'string');
    return keyed ? out.sort((a, b) => natural(a.id, b.id)) : out;
  }
  if (!isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v).sort()) put(o, k, sortDeep(v[k]));
  return o;
}

// The one shape a state is stored and compared in: JSON values only, keys in
// sorted order, and arrays of records with an `id` sorted by it.
export const canonical = (v) => (v === null || v === undefined ? null : sortDeep(JSON.parse(JSON.stringify(v))));
const clone = (v) => JSON.parse(JSON.stringify(v));

function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

// The smallest list of ops that turns a into b: set, del, and push for an array that grew.
export function diff(a, b, path = [], ops = []) {
  if (equal(a, b)) return ops;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) ops.push({ op: 'del', path: [...path, k] });
    for (const k of Object.keys(b)) {
      if (Object.hasOwn(a, k)) diff(a[k], b[k], [...path, k], ops);
      else ops.push({ op: 'set', path: [...path, k], value: b[k] });
    }
  } else if (Array.isArray(a) && Array.isArray(b) && b.length >= a.length) {
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...path, i], ops);
    if (b.length > a.length) ops.push({ op: 'push', path, values: b.slice(a.length) });
  } else ops.push({ op: 'set', path, value: b });
  return ops;
}

export function apply(state, ops) {
  let root = state;
  for (const o of ops) {
    const where = o.path.slice(0, -1).reduce((x, k) => {
      if (x === null || typeof x !== 'object' || !Object.hasOwn(x, k)) throw new Error(`op ${o.op} ${o.path.join('.')}: no such path`);
      return x[k];
    }, root);
    const k = o.path.at(-1);
    if (o.op === 'set') { if (!o.path.length) root = clone(o.value); else if (where && typeof where === 'object') put(where, k, clone(o.value)); else throw new Error(`op set ${o.path.join('.')}: no such path`); }
    else if (o.op === 'del') { if (!isObj(where) || !Object.hasOwn(where, k)) throw new Error(`op del ${o.path.join('.')}: no such key`); delete where[k]; }
    else {
      const arr = o.path.length ? where?.[k] : root;
      if (!Array.isArray(arr)) throw new Error(`op push ${o.path.join('.')}: not a list`);
      arr.push(...clone(o.values));
    }
  }
  return root;
}

// The state the events describe.
export function replay(events) {
  let s = null;
  for (const e of events) s = e.kind === 'run.imported' ? clone(e.payload.state) : apply(s, e.payload.ops);
  return canonical(s);
}

// Parses and validates the whole log. Fails loudly on a torn line, bad JSON,
// an event that breaks its schema, or a seq that skips or repeats.
export function parseLog(buf, name = EVENTS) {
  const events = []; const ends = [];
  for (let start = 0; start < buf.length;) {
    const nl = buf.indexOf(10, start);
    const n = events.length + 1;
    if (nl < 0) throw new Error(`${name}: line ${n} has no end (a torn write); restore the file from a copy or run.mjs pull`);
    let e;
    try { e = JSON.parse(buf.subarray(start, nl).toString('utf8')); } catch { throw new Error(`${name}: line ${n} is not JSON`); }
    validateEvent(e, `${name}: line ${n}`);
    if (e.seq !== n) throw new Error(`${name}: line ${n} has seq ${e.seq}; the log has a gap or a repeat`);
    events.push(e); ends.push(nl + 1); start = nl + 1;
  }
  return { buf, events, ends };
}

const logHash = (log, seq) => sha256(log.buf.subarray(0, seq ? log.ends[seq - 1] : 0));
const stateHash = (state) => sha256(JSON.stringify(state));

function readLog(dir) {
  const file = join(dir, EVENTS);
  return existsSync(file) ? parseLog(readFileSync(file), file) : null;
}

// The run in `dir`, or null if there is none. Returns { state, seq, log } and,
// when relevant: legacy (a state.json from before the log), rebuilt (the
// snapshot was behind or did not match), edited (state.json was changed
// outside run.mjs; the next write records the difference as state.edited).
export function readRun(dir) {
  const file = join(dir, STATE);
  const log = readLog(dir);
  let snap; let bad = null;
  if (existsSync(file)) { try { snap = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { bad = e.message; } }
  if (!log) {
    if (bad) throw new Error(`${file}: ${bad}`);
    if (snap === undefined) return null;
    if (isObj(snap) && Object.hasOwn(snap, META)) throw new Error(`${file} is a snapshot of event ${snap[META]?.seq}, but ${EVENTS} is missing: restore it (run.mjs pull) or remove the "${META}" key to import the state as it is`);
    const err = validRun(snap);
    if (err) throw new Error(`${file}: ${err}`);
    return { state: canonical(snap), seq: 0, log: null, legacy: true };
  }
  const n = log.events.length;
  if (!n) throw new Error(`${join(dir, EVENTS)} is empty`);
  const meta = isObj(snap) ? snap[META] : undefined;
  if (meta && validSnapshot(meta) && meta.seq > n) throw new Error(`${file} is a snapshot of event ${meta.seq}, but ${EVENTS} ends at ${n}: the log lost events; restore it (run.mjs pull)`);
  if (meta && validSnapshot(meta) && meta.seq === n && logHash(log, n) === meta.sha256) {
    const { [META]: _, ...body } = snap;
    const state = canonical(body);
    if (validRun(state) === null) return { state, seq: n, log, edited: stateHash(state) !== meta.stateSha256 };
  }
  return { state: replay(log.events), seq: n, log, rebuilt: true };
}

export const snapshotText = (state, seq, buf) => `${JSON.stringify(canonical({ ...state, [META]: { v: V, seq, sha256: sha256(buf), stateSha256: stateHash(state) } }), null, 2)}\n`;
const line = (seq, kind, unit, payload) => validateEvent({ v: V, seq, at: new Date().toISOString(), kind, ...(unit ? { unit } : {}), payload }, `new event ${seq}`);

// Change a run under its lock: `mutate` gets the state (null for a new run) and
// may change it or return a new one. The difference is appended as one event
// of `kind`, then the snapshot is rewritten; both writes are atomic. A change
// that changes nothing writes nothing. `after` runs in the same lock.
export function updateRun(dir, { kind, unit = null }, mutate, after) {
  const file = join(dir, STATE);
  return withLock(file, () => {
    const cur = readRun(dir);
    let seq = cur?.seq ?? 0;
    const lines = [];
    const add = (k, payload, u = null) => { seq++; lines.push(`${JSON.stringify(line(seq, k, u, payload))}\n`); };
    if (cur?.legacy) add('run.imported', { state: cur.state, from: STATE });
    if (cur?.edited) { const ops = diff(replay(cur.log.events), cur.state); if (ops.length) add('state.edited', { ops }); }
    const before = cur?.state ?? null;
    const work = before === null ? null : clone(before);
    const next = canonical(mutate(work) ?? work);
    if (next === null) throw new Error('a run cannot be empty');
    const ops = diff(before, next);
    if (ops.length) add(kind, { ops }, unit);
    if (lines.length || cur?.rebuilt || cur?.edited) {
      const buf = Buffer.concat([cur?.log?.buf ?? Buffer.alloc(0), Buffer.from(lines.join(''))]);
      if (lines.length) writeAtomic(join(dir, EVENTS), buf);
      writeAtomic(file, snapshotText(next, seq, buf));
    }
    after?.(next);
    return next;
  });
}

// Reads a run for display. Never writes: a stale snapshot is rebuilt in memory.
export function loadRun(dir) {
  const r = readRun(dir);
  if (!r) throw new Error(`no run in ${dir}`);
  return r.state;
}
