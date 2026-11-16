// #132: a run paused by hand (run.mjs pause / resume) spends none of its time budget while paused,
// and `next` on a run past its time budget only reports the stops it would make: close records them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSync } from './inproc.mjs';
import { allows, decide, decideUnit } from '../lib/rules.mjs';
import { pausedMinutes, usedMinutes } from '../lib/clock.mjs';
import { estimate } from '../lib/plain.mjs';
import { runStatus } from '../lib/progress.mjs';
import { statusChip } from '../lib/hud.mjs';
import { text as textView, view } from '../lib/view.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * MIN).toISOString();
const run = (units, extra = {}) => ({
  id: 'r', goal: 'g', bar: 'b', fence: 'f', tag: 'code', createdAt: at(0), frozen: true, integration: { rounds: [] }, notes: [],
  budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, units, ...extra,
});
const unit = (rounds = [], extra = {}) => ({ id: 'u1', bar: 'b', status: 'open', rounds, strategyChanges: 0, strategyAt: -1, ...extra });
const question = (minute, answeredMinute) => ({
  kind: 'question', text: 'Which way?', header: 'Way', options: [{ label: 'A' }, { label: 'B' }], unit: null, at: at(minute), usedAt: null,
  history: answeredMinute === null ? [] : [{ choices: ['A'], other: null, by: 'person', via: 'dashboard', at: at(answeredMinute) }],
});

// B1: the minutes between pause and resume count toward no budget, and every reader agrees.
test('paused minutes count toward no budget: next, show and the ETA read the same clock', () => {
  const u = unit([{ n: 1, verdict: 'fail', gap: 'g', severity: 'high', score: 5, at: at(60) }]);
  // Paused overnight from minute 100 to minute 400 (five hours) on a 240-minute budget.
  const r = run([u], { pauses: [{ from: at(100), to: at(400), reason: 'overnight' }] });
  const nowMs = T0 + 500 * MIN;
  assert.equal(pausedMinutes(r, nowMs), 300);
  assert.equal(usedMinutes(r, nowMs), 200);
  assert.equal(decideUnit(u, r, nowMs).action, 'build', 'not stopped for time: only 200 of 240 minutes were spent');
  assert.equal(estimate(r, decide(r, nowMs), nowMs).budgetLeft, 40, 'the ETA has the same 40 minutes left');
  assert.match(textView(view(r, decide(r, nowMs), nowMs)), /time 200\/240 min \(300 min on pause\)/, "show's time line");
  // Without the pause the same run is past its budget.
  assert.equal(decideUnit(u, run([u]), nowMs).reason, 'budget: time');
  // A pause and an open question that overlap count once (100 to 450).
  const both = run([u], { pauses: [{ from: at(100), to: at(400), reason: 'overnight' }], notes: [question(150, 450)] });
  assert.equal(pausedMinutes(both, nowMs), 350);
  assert.match(textView(view(both, decide(both, nowMs), nowMs)), /\(300 min on pause, 50 min paused while the person decided and no unit was at work\)/);
  // A pause still open runs to now; read at a past time it is cut there.
  const open = run([u], { pauses: [{ from: at(100), reason: 'overnight' }] });
  assert.equal(pausedMinutes(open, nowMs), 400);
  assert.equal(usedMinutes(open, nowMs), 100);
  assert.equal(pausedMinutes(open, T0 + 150 * MIN), 50);
  // A unit at work during the pause does not shorten it: paused time never counts.
  const busy = { ...unit([], { status: 'building', heartbeatAt: at(90) }), log: [{ kind: 'start', text: 'try 1', at: at(90) }] };
  assert.equal(pausedMinutes(run([busy], { pauses: [{ from: at(100), to: at(400), reason: 'x' }] }), nowMs), 300);
});

test('show and the dashboard say the run is paused while it is', () => {
  const r = run([unit()], { pauses: [{ from: at(100), reason: 'overnight' }] });
  const nowMs = T0 + 130 * MIN;
  const st = runStatus(r, decide(r, nowMs), { nowMs, timeZone: 'UTC' });
  assert.equal(st.kind, 'paused');
  assert.equal(st.word, 'Paused');
  assert.match(st.doing, /paused since .*: overnight/);
  assert.equal(st.eta.readyAt, null, 'no ready time while the clock is stopped');
  assert.equal(st.eta.short, 'clock stopped');
  assert.equal(st.line, 'r · Paused: 0 of 1 unit done (0%), paused since 01:40: overnight (run.mjs resume r to go on), clock stopped. Nothing needs you.', 'the status line');
  assert.match(statusChip(st), /Paused/, 'the dashboard chip');
  const shown = textView(view(r, decide(r, nowMs), nowMs));
  assert.match(shown, /^r \[code\] · Paused · /);
  assert.match(shown, /run\.mjs resume r/);
  // Resumed: running again.
  const resumed = run([unit()], { pauses: [{ from: at(100), to: at(120), reason: 'overnight' }] });
  assert.equal(runStatus(resumed, decide(resumed, nowMs), { nowMs }).kind, 'running');
});

// B2 on the rules: a paused run starts no work; a running critic may still report.
test('while paused, no unit is started: build, judge, fold-in and stale checks wait', () => {
  const paused = { pauses: [{ from: at(10), reason: 'overnight' }] };
  const nowMs = T0 + 20 * MIN;
  const d = decideUnit(unit(), run([unit()], paused), nowMs);
  assert.equal(d.action, 'wait');
  assert.equal(d.paused, true);
  assert.ok(!allows('start', d), 'start is refused');
  const judging = unit([], { status: 'judging', judgingAt: at(5), heartbeatAt: at(5) });
  const dj = decideUnit(judging, run([judging], paused), nowMs);
  assert.equal(dj.action, 'wait');
  assert.ok(allows('verdict', dj), 'a critic already at work may still record its verdict');
  assert.equal(decideUnit(unit(), run([unit()]), nowMs).action, 'build', 'not paused: build');
});

const dir = mkdtempSync(join(tmpdir(), 'coordinator-pause-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
function cli(...args) {
  const r = runSync(args, { env: { ...process.env, COORDINATOR_DIR: dir } });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const refused = (re, ...a) => { const r = cli(...a); assert.equal(r.code, 1, `${a.join(' ')} should be refused`); assert.match(r.err, re); return r.err; };
const files = (r) => ['state.json', 'events.jsonl'].map((f) => readFileSync(join(dir, 'runs', r, f), 'utf8'));
const stateFile = (r) => join(dir, 'runs', r, 'state.json');
// A hand edit of the snapshot (the next write records it as state.edited): moves the run's times into the past.
const edit = (r, fn) => { const s = JSON.parse(readFileSync(stateFile(r), 'utf8')); fn(s); writeFileSync(stateFile(r), JSON.stringify(s)); };
const ago = (min) => new Date(Date.now() - min * MIN).toISOString();

// B1 and B2 through the CLI.
test('pause and resume through the CLI: next says paused and how to resume; start, a second pause and a stray resume are refused', () => {
  ok('init', 'p1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'p1', 'a', '--bar', 'b'); ok('freeze', 'p1');
  refused(/--reason/, 'pause', 'p1');
  refused(/resume refused: run p1 is not paused/, 'resume', 'p1');
  ok('pause', 'p1', '--reason', 'overnight, the PC restarts');
  const n = ok('next', 'p1');
  assert.equal(n.decision, 'paused');
  assert.equal(n.paused.reason, 'overnight, the PC restarts');
  assert.match(n.paused.step, /run\.mjs resume p1/);
  assert.deepEqual(n.units.map((u) => u.action), ['wait']);
  refused(/start refused: run p1 is paused since .* \(overnight, the PC restarts\); run\.mjs resume p1 first/, 'start', 'p1', 'a');
  refused(/pause refused: run p1 is already paused since /, 'pause', 'p1', '--reason', 'again');
  assert.match(ok('show', 'p1'), /· Paused ·/);
  ok('resume', 'p1');
  assert.equal(ok('next', 'p1').units[0].action, 'build');
  const s = JSON.parse(readFileSync(stateFile('p1'), 'utf8'));
  assert.equal(s.pauses.length, 1);
  assert.equal(s.pauses[0].reason, 'overnight, the PC restarts');
  assert.ok(Date.parse(s.pauses[0].to) >= Date.parse(s.pauses[0].from));
  const kinds = readFileSync(join(dir, 'runs', 'p1', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith('run.pause') || k.startsWith('run.resume')), ['run.pause', 'run.resume']);
  // Five hours paused on a 240-minute budget begun six hours ago: one hour used, nothing stopped.
  edit('p1', (st) => { st.createdAt = ago(360); st.pauses[0].from = ago(330); st.pauses[0].to = ago(30); });
  assert.equal(ok('next', 'p1').units[0].action, 'build');
  assert.match(ok('show', 'p1'), /time 60\/240 min \(300 min on pause\)/);
  ok('start', 'p1', 'a');
});

// B3: next on a run past its time budget writes nothing and says what close will record.
test('next on a run past its time budget changes nothing and reports the stops; close records them', () => {
  ok('init', 'p2', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  ok('add', 'p2', 'a', '--bar', 'b'); ok('add', 'p2', 'b', '--bar', 'b', '--after', 'a'); ok('freeze', 'p2');
  ok('start', 'p2', 'a');
  edit('p2', (st) => { st.createdAt = ago(300); });
  const before = files('p2');
  const n = ok('next', 'p2');
  assert.deepEqual(files('p2'), before, 'state.json and events.jsonl are unchanged');
  assert.deepEqual(n.units.map((u) => [u.id, u.action, u.reason, u.recorded]), [['a', 'stop', 'budget: time', false], ['b', 'stop', 'budget: time', false]]);
  assert.match(n.spent.step, /run\.mjs close p2 --outcome stopped/);
  assert.deepEqual(files('p2'), before, 'a second look changes nothing either');
  ok('show', 'p2');
  assert.deepEqual(files('p2'), before, 'show changes nothing');
  ok('close', 'p2', '--outcome', 'stopped');
  const s = JSON.parse(readFileSync(stateFile('p2'), 'utf8'));
  assert.deepEqual(s.units.map((u) => [u.id, u.status, u.stopReason]), [['a', 'stopped', 'budget: time'], ['b', 'stopped', 'budget: time']]);
});
