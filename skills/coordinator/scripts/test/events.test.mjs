import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KINDS, schemaFor, validateEvent } from '../lib/eventschema.mjs';
import { apply, canonical, diff, parseLog, readRun, replay, sha256, updateRun } from '../lib/events.mjs';
import { check } from '../lib/schema.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-events-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, COORDINATOR_DIR: dir };
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const run = (...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8' }); return { code: r.status, out: json(r.stdout), err: r.stderr }; };
const runDir = (r) => join(dir, 'runs', r);
const lines = (r) => readFileSync(join(runDir(r), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const snap = (r) => JSON.parse(readFileSync(join(runDir(r), 'state.json'), 'utf8'));
const body = (s) => { const { snapshot, ...b } = s; return b; };
const setup = (r) => { run('init', r, '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', r, 'u2', '--bar', 'b'); run('add', r, 'u10', '--bar', 'b'); run('add', r, 'u1', '--bar', 'b', '--behaviour', 'Given x when y then z'); };

test('every change appends one event with v, seq, at, kind and unit; no-op steps append none', () => {
  setup('e1');
  run('freeze', 'e1'); run('start', 'e1', 'u1'); run('beat', 'e1', 'u1', '--text', 'pushed');
  const before = lines('e1').length;
  run('show', 'e1'); run('questions', 'e1'); run('hud', 'e1');
  assert.equal(run('next', 'e1').code, 0);
  const ev = lines('e1');
  assert.equal(ev.length, before, 'reads and an unchanged next add nothing');
  assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1));
  assert.deepEqual(ev.map((e) => e.kind), ['run.init', 'unit.add', 'unit.add', 'unit.add', 'run.freeze', 'unit.start', 'unit.beat']);
  assert.deepEqual(Object.keys(ev[6]), ['v', 'seq', 'at', 'kind', 'unit', 'payload']);
  assert.equal(ev[6].unit, 'u1');
  assert.equal(ev[4].unit, undefined);
  for (const e of ev) { assert.equal(e.v, 1); assert.match(e.at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/); validateEvent(e); }
  assert.equal(readFileSync(join(runDir('e1'), 'events.jsonl'), 'utf8').includes('\n  '), false, 'one line per event, never pretty-printed');
});

test('the snapshot is derived from the events: stable keys, planned order, last seq and a hash of the log', () => {
  setup('e2');
  const s = snap('e2');
  const raw = readFileSync(join(runDir('e2'), 'events.jsonl'));
  assert.deepEqual(s.snapshot.seq, 4);
  assert.equal(s.snapshot.sha256, sha256(raw));
  assert.deepEqual(body(s), replay(parseLog(raw).events));
  assert.deepEqual(s.units.map((u) => u.id), ['u2', 'u10', 'u1'], 'units stay in the order they were planned');
  assert.equal(readFileSync(join(runDir('e2'), 'state.json'), 'utf8').trim().split('\n').length, 1, 'compact');
  const keys = Object.keys(s); assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(Object.keys(s.units[0]), [...Object.keys(s.units[0])].sort());
});

test('a gap (log ahead of the snapshot) or a bad hash rebuilds the state from the events', () => {
  setup('e3');
  const file = join(runDir('e3'), 'state.json');
  const good = readFileSync(file, 'utf8');
  run('freeze', 'e3');
  writeFileSync(file, good); // the snapshot is one event behind the log
  let r = readRun(runDir('e3'));
  assert.equal(r.rebuilt, true);
  assert.equal(r.state.frozen, true);
  assert.equal(run('show', 'e3').code, 0);
  const s = snap('e3'); s.snapshot.sha256 = '0'.repeat(64); s.frozen = false;
  writeFileSync(file, JSON.stringify(s)); // a hash that does not match the log
  r = readRun(runDir('e3'));
  assert.equal(r.rebuilt, true); assert.equal(r.state.frozen, true);
  writeFileSync(file, '{ not json'); // an unreadable snapshot
  assert.equal(readRun(runDir('e3')).state.frozen, true);
  assert.equal(run('start', 'e3', 'u1').code, 0, 'a write repairs the snapshot');
  assert.equal(snap('e3').snapshot.seq, 6);
  assert.equal(readRun(runDir('e3')).rebuilt, undefined);
});

test('a broken log fails loudly: torn line, bad JSON, wrong schema, seq gap, lost events', () => {
  setup('e4');
  const log = join(runDir('e4'), 'events.jsonl');
  const good = readFileSync(log, 'utf8');
  const cases = [
    [good.slice(0, -5), /torn write/],
    [`${good}{oops\n`, /line 5 is not JSON/],
    [good.replace('"kind":"unit.add"', '"kind":"unit.explode"'), /unknown event kind/],
    [good.replace('"seq":3', '"seq":7'), /seq 7; the log has a gap/],
    [good.replace(/"unit":"u2",/, ''), /missing unit/],
    [good.replace('"v":1,"seq":2', '"v":2,"seq":2'), /\$\.v: expected 1/],
    [good.split('\n').slice(0, 2).join('\n') + '\n', /lost events/],
  ];
  for (const [text, re] of cases) {
    writeFileSync(log, text);
    assert.throws(() => readRun(runDir('e4')), re);
    const r = run('show', 'e4'); assert.equal(r.code, 1); assert.match(r.err, re);
  }
  writeFileSync(log, good);
  assert.equal(run('show', 'e4').code, 0);
});

test('every event kind has a JSON Schema; writes that break it are refused', () => {
  for (const k of Object.keys(KINDS)) assert.equal(schemaFor(k).properties.kind.const, k);
  assert.throws(() => validateEvent({ v: 1, seq: 2, at: '2026-11-06T10:00:00.000Z', kind: 'unit.start', payload: { ops: [{ op: 'set', path: ['units'], value: [] }] } }), /missing unit/);
  assert.throws(() => validateEvent({ v: 1, seq: 2, at: '2026-11-06T10:00:00.000Z', kind: 'note', payload: { ops: [{ op: 'set', path: ['__proto__', 'x'], value: 1 }] } }), /fits none/);
  assert.throws(() => validateEvent({ v: 1, seq: 2, at: 'yesterday', kind: 'note', payload: { ops: [{ op: 'del', path: ['x'] }] } }), /at/);
  assert.throws(() => validateEvent({ v: 1, seq: 3, at: '2026-11-06T10:00:00Z', kind: 'run.init', payload: { ops: [] } }), /seq/);
  assert.equal(check({ type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer', minimum: 1 } } }, { a: 1 }), null);
  setup('e5');
  assert.throws(() => updateRun(runDir('e5'), { kind: 'unit.start' }, (s) => { s.frozen = true; }), /missing unit/);
  assert.throws(() => updateRun(runDir('e5'), { kind: 'no.such' }, (s) => { s.frozen = true; }), /unknown event kind/);
  assert.equal(lines('e5').length, 4, 'nothing was written');
  assert.equal(snap('e5').frozen, false);
});

test('unit events read on their own: add carries the unit, later changes name it by id', () => {
  run('init', 'e8', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'e8', 'zeta', '--bar', 'base'); run('add', 'e8', 'alpha', '--bar', 'stacked', '--after', 'zeta');
  run('freeze', 'e8'); run('start', 'e8', 'zeta');
  const ev = lines('e8');
  const add = ev.find((e) => e.kind === 'unit.add' && e.unit === 'alpha');
  assert.deepEqual(add.payload.ops.map((o) => [o.op, o.path]), [['push', ['units']]]);
  assert.equal(add.payload.ops[0].values[0].id, 'alpha');
  assert.equal(add.payload.ops[0].values[0].after, 'zeta');
  const start = ev.find((e) => e.kind === 'unit.start');
  assert.ok(start.payload.ops.every((o) => JSON.stringify(o.path.slice(0, 2)) === JSON.stringify(['units', { id: 'zeta' }])), 'addressed by id, not position');
  assert.deepEqual(run('next', 'e8').out.units.map((u) => u.id), ['zeta', 'alpha'], 'a stacked unit is listed after its base');
  assert.deepEqual(snap('e8').units.map((u) => u.id), ['zeta', 'alpha']);
  assert.ok(readFileSync(join(runDir('e8'), 'hud.html'), 'utf8').indexOf('zeta') < readFileSync(join(runDir('e8'), 'hud.html'), 'utf8').indexOf('alpha'));
});

test('diff and apply turn one state into another exactly', () => {
  const a = canonical({ id: 'r', units: [{ id: 'b', rounds: [1] }, { id: 'a', log: [] }], notes: ['x'], gone: 1, n: { deep: { k: 'v' } } });
  const b = canonical({ id: 'r', units: [{ id: 'a', log: [{ kind: 'beat' }] }, { id: 'b', rounds: [1, 2] }, { id: 'c' }], notes: ['x', 'y'], n: { deep: { k: 'w', z: null } }, added: [true] });
  const ops = diff(a, b);
  assert.deepEqual(canonical(apply(structuredClone(a), ops)), b);
  assert.ok(ops.some((o) => o.op === 'push' && o.path.join('.') === 'notes'));
  assert.ok(ops.some((o) => o.op === 'del' && o.path.join('.') === 'gone'));
  assert.deepEqual(diff(b, b), []);
  const c = canonical({ units: [{ id: 'a', s: 1 }, { id: 'b', s: 1 }] });
  const d = canonical({ units: [{ id: 'a', s: 1 }, { id: 'b', s: 2 }, { id: 'c', s: 0 }] });
  assert.deepEqual(diff(c, d), [{ op: 'set', path: ['units', { id: 'b' }, 's'], value: 2 }, { op: 'push', path: ['units'], values: [{ id: 'c', s: 0 }] }]);
  assert.deepEqual(apply(structuredClone(c), diff(c, d)), d);
  const e = canonical({ units: [{ id: 'b', s: 1 }] });
  assert.deepEqual(diff(c, e), [{ op: 'del', path: ['units', { id: 'a' }] }]);
  assert.deepEqual(apply(structuredClone(c), diff(c, e)), e);
  assert.throws(() => apply(structuredClone(c), [{ op: 'set', path: ['units', { id: 'zz' }, 's'], value: 1 }]), /no item with id zz/);
  assert.throws(() => apply({ x: 1 }, [{ op: 'del', path: ['y'] }]), /no such path/);
});

test('hand edits to state.json are kept as a state.edited event, so the log still replays to the snapshot', () => {
  setup('e6');
  const file = join(runDir('e6'), 'state.json');
  const s = snap('e6'); s.createdAt = '2020-01-01T00:00:00.000Z'; writeFileSync(file, JSON.stringify(s));
  assert.equal(readRun(runDir('e6')).edited, true);
  assert.equal(run('note', 'e6', '--kind', 'info', '--text', 'hi').code, 0);
  const ev = lines('e6');
  assert.deepEqual(ev.slice(-2).map((e) => e.kind), ['state.edited', 'note']);
  assert.deepEqual(body(snap('e6')), replay(ev));
  assert.equal(snap('e6').createdAt, '2020-01-01T00:00:00.000Z');
});

function legacy(r, state) {
  mkdirSync(runDir(r), { recursive: true });
  writeFileSync(join(runDir(r), 'state.json'), JSON.stringify(state, null, 2));
}

test('a 0.5 state.json with no events loads as before and gets a run.imported baseline on the first write', () => {
  setup('e7');
  const old = body(snap('e7'));
  rmSync(runDir('e7'), { recursive: true });
  legacy('e7', old);
  assert.equal(run('show', 'e7').code, 0);
  assert.equal(existsSync(join(runDir('e7'), 'events.jsonl')), false, 'reading never migrates');
  assert.equal(run('freeze', 'e7').code, 0);
  const ev = lines('e7');
  assert.deepEqual(ev.map((e) => [e.seq, e.kind]), [[1, 'run.imported'], [2, 'run.freeze']]);
  assert.deepEqual(ev[0].payload.state, canonical(old));
  assert.equal(snap('e7').frozen, true);
  assert.deepEqual(body(snap('e7')), replay(ev));
  assert.equal(run('list').out.find((x) => x.run === 'e7').decision, 'continue');
  // A snapshot that names events which are gone is not silently re-imported.
  rmSync(join(runDir('e7'), 'events.jsonl'));
  assert.match(run('show', 'e7').err, /events\.jsonl is missing/);
});

// A real run folder written by 0.5, copied (never touched in place). Skipped where it does not exist.
const REAL = process.env.COORDINATOR_REAL_STATE ?? 'D:/projects/mindmakr/payday-web-nextjs/.coordinator/runs/payday-wave1/state.json';
test('a real 0.5 run folder migrates on a copy and behaves as before', { skip: !existsSync(REAL) && 'no real 0.5 state on this machine' }, () => {
  const old = JSON.parse(readFileSync(REAL, 'utf8'));
  mkdirSync(runDir(old.id), { recursive: true });
  copyFileSync(REAL, join(runDir(old.id), 'state.json'));
  const shownBefore = run('show', old.id);
  assert.equal(shownBefore.code, 0, shownBefore.err);
  const qBefore = run('questions', old.id).out;
  const listed = run('list').out.find((x) => x.run === old.id);
  // The first write migrates: a baseline holding the old state, then the change itself.
  const r = run('note', old.id, '--kind', 'follow-up', '--text', 'migration check');
  assert.equal(r.code, 0, r.err);
  const ev = lines(old.id);
  assert.deepEqual(ev.map((e) => e.kind), ['run.imported', 'note']);
  assert.deepEqual(ev[0].payload.state, canonical(old));
  const now = body(snap(old.id));
  assert.deepEqual({ ...now, notes: now.notes.slice(0, -1) }, canonical(old), 'nothing but the new note changed');
  assert.deepEqual(now, replay(ev));
  assert.deepEqual(run('questions', old.id).out, qBefore);
  assert.equal(run('list').out.find((x) => x.run === old.id).decision, listed.decision);
  assert.equal(run('show', old.id).out.split('\n')[0], shownBefore.out.split('\n')[0]);
});
