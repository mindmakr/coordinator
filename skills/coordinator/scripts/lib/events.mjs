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

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (!isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v).sort()) put(o, k, sortDeep(v[k]));
  return o;
}

// The one shape a state is stored and compared in: JSON values only, keys in
// sorted order. Arrays keep their order: units in the order they were planned
// (a stacked unit after its base), notes and rounds in the order they happened.
export const canonical = (v) => (v === null || v === undefined ? null : sortDeep(JSON.parse(JSON.stringify(v))));
const clone = (v) => JSON.parse(JSON.stringify(v));

function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

// A list of records with unique string ids (units, behaviours, evidence): ops
// address its items by id ({ "id": "u1" } in a path), never by position.
const keyed = (x) => Array.isArray(x) && x.every((e) => isObj(e) && typeof e.id === 'string') && new Set(x.map((e) => e.id)).size === x.length;
// b keeps a's items in a's order (some may be gone) and only adds new ones at the end.
function grows(a, b) {
  const was = new Set(a.map((e) => e.id)); const is = new Set(b.map((e) => e.id));
  const kept = b.filter((e) => was.has(e.id)).map((e) => e.id);
  return JSON.stringify(kept) === JSON.stringify(a.filter((e) => is.has(e.id)).map((e) => e.id)) && b.slice(0, kept.length).every((e) => was.has(e.id));
}
const show = (path) => path.map((k) => (isObj(k) ? `[id=${k.id}]` : k)).join('.');

// The smallest list of ops that turns a into b: set, del, and push for a list that grew.
export function diff(a, b, path = [], ops = []) {
  if (equal(a, b)) return ops;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) ops.push({ op: 'del', path: [...path, k] });
    for (const k of Object.keys(b)) {
      if (Object.hasOwn(a, k)) diff(a[k], b[k], [...path, k], ops);
      else ops.push({ op: 'set', path: [...path, k], value: b[k] });
    }
  } else if (a?.length && keyed(a) && keyed(b) && grows(a, b)) {
    const old = new Map(a.map((e) => [e.id, e])); const ids = new Set(b.map((e) => e.id));
    for (const e of a) if (!ids.has(e.id)) ops.push({ op: 'del', path: [...path, { id: e.id }] });
    for (const e of b) if (old.has(e.id)) diff(old.get(e.id), e, [...path, { id: e.id }], ops);
    const fresh = b.filter((e) => !old.has(e.id));
    if (fresh.length) ops.push({ op: 'push', path, values: fresh });
  } else if (Array.isArray(a) && Array.isArray(b) && b.length >= a.length && !(a.length && keyed(a))) {
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...path, i], ops);
    if (b.length > a.length) ops.push({ op: 'push', path, values: b.slice(a.length) });
  } else ops.push({ op: 'set', path, value: b });
  return ops;
}

// Where a path segment points: an object key, an array index, or the item with an id.
function slot(x, k, o) {
  if (isObj(k)) {
    const i = Array.isArray(x) ? x.findIndex((e) => isObj(e) && e.id === k.id) : -1;
    if (i < 0) throw new Error(`op ${o.op} ${show(o.path)}: no item with id ${k.id}`);
    return i;
  }
  if (x === null || typeof x !== 'object' || !Object.hasOwn(x, k)) throw new Error(`op ${o.op} ${show(o.path)}: no such path`);
  return k;
}

export function apply(state, ops) {
  let root = state;
  for (const o of ops) {
    const where = o.path.slice(0, -1).reduce((x, k) => x[slot(x, k, o)], root);
    const k = o.path.at(-1);
    if (o.op === 'set') {
      if (!o.path.length) root = clone(o.value);
      else if (isObj(k)) where[slot(where, k, o)] = clone(o.value);
      else if (where && typeof where === 'object') put(where, k, clone(o.value));
      else throw new Error(`op set ${show(o.path)}: no such path`);
    } else if (o.op === 'del') {
      const i = slot(where, k, o);
      if (Array.isArray(where)) where.splice(i, 1); else delete where[i];
    } else {
      const arr = o.path.length ? where?.[slot(where, k, o)] : root;
      if (!Array.isArray(arr)) throw new Error(`op push ${show(o.path)}: not a list`);
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

export const snapshotText = (state, seq, buf) => `${JSON.stringify(canonical({ ...state, [META]: { v: V, seq, sha256: sha256(buf), stateSha256: stateHash(state) } }))}\n`;
const line = (seq, kind, unit, payload) => validateEvent({ v: V, seq, at: new Date().toISOString(), kind, ...(unit ? { unit } : {}), payload }, `new event ${seq}`);

// Change a run under its lock: `mutate` gets the state (null for a new run) and
// may change it or return a new one. The difference is appended as one event
// of `kind`, then the snapshot is rewritten; both writes are atomic. A change
// that changes nothing writes nothing. `after` runs in the same lock.
// by: { harness, skill } (lib/harness.mjs). Every event that changes something
// also sets the state's `writer` to it, as one more op: older copies of the
// skill read the line as an ordinary change, so the log stays readable to them.
export function updateRun(dir, { kind, unit = null, by = null }, mutate, after) {
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
    let next = canonical(mutate(work) ?? work);
    if (next === null) throw new Error('a run cannot be empty');
    if (by && before === null) next = canonical({ ...next, startedBy: by, writer: by });
    const ops = diff(before, next);
    if (by && before !== null && ops.length) {
      const w = canonical(by);
      if (!equal(next.writer, w)) next = canonical({ ...next, writer: w });
      const i = ops.findIndex((o) => o.path.length === 1 && o.path[0] === 'writer');
      if (i >= 0) ops.splice(i, 1);
      ops.push({ op: 'set', path: ['writer'], value: w });
    }
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
