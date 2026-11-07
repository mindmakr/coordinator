// A unit finished in a follow-on run (#36): the link on both runs, the pages,
// stats counting a chain once, and a person-approved extra round (`extend`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chainLine, chainOf, chainUnits, linkedRuns, parseContinues } from '../lib/chain.mjs';
import { decide, decideUnit, stats } from '../lib/rules.mjs';
import { selfModel, selfText } from '../lib/self.mjs';
import { flowGraph } from '../lib/maps.mjs';
import { text as textView, view } from '../lib/view.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-chain-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args) => {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout && r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : r.stdout, err: r.stderr };
};
const state = (id) => JSON.parse(readFileSync(join(dir, 'runs', id, 'state.json'), 'utf8'));

const T = '2026-11-06T16:00:00.000Z';
const budget = { maxRounds: 3, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 };
const r = (n, verdict = 'fail') => Array.from({ length: n }, (_, i) => ({ n: i + 1, verdict: i === n - 1 ? verdict : 'fail', score: 6, gap: `g${i}`, at: T }));
const mk = (id, units, extra = {}) => ({ id, createdAt: extra.createdAt ?? T, frozen: true, budget, notes: [], integration: { rounds: [] }, units, closed: { outcome: 'partial', at: T }, ...extra });
// The real shape from this project: c11 stopped in 1.0 (3 rounds), passed in 1.0b (3 rounds);
// c14 across 1.0b → 1.0c → 1.0d; m3 stopped (blocked) in 1.1, continued in 1.1b.
const real = () => [
  mk('coordinator-1.0', [{ id: 'c11', status: 'stopped', stopReason: 'budget: rounds', rounds: r(3), continuedIn: [{ run: 'coordinator-1.0b' }] }, { id: 'c19', status: 'pass', rounds: r(1, 'pass') }]),
  mk('coordinator-1.0b', [{ id: 'c11', status: 'pass', rounds: r(3, 'pass') }, { id: 'c14', status: 'stopped', stopReason: 'budget: time', rounds: r(1) }], { createdAt: '2026-11-06T19:39:00.000Z', continues: [{ run: 'coordinator-1.0', unit: 'c11' }] }),
  mk('coordinator-1.0c', [{ id: 'c14', status: 'stopped', stopReason: 'budget: time', rounds: r(2) }], { createdAt: '2026-11-06T23:42:00.000Z', continues: [{ run: 'coordinator-1.0b', unit: 'c14' }] }),
  mk('coordinator-1.0d', [{ id: 'c14', status: 'pass', rounds: r(1, 'pass') }], { createdAt: '2026-11-07T07:00:00.000Z', continues: [{ run: 'coordinator-1.0c', unit: 'c14' }] }),
];

test('--continues parses <run>:<unit> and nothing else', () => {
  assert.deepEqual(parseContinues('coordinator-1.0:c11'), { run: 'coordinator-1.0', unit: 'c11' });
  for (const bad of ['c11', 'a:b:c', ':c11', 'run:', '../x:c11', undefined]) assert.throws(() => parseContinues(bad), /--continues must be/);
});

test('a chain runs oldest first and reads the same from any link', () => {
  const runs = real();
  const c = chainOf(runs, 'coordinator-1.0c', 'c14');
  assert.deepEqual(c.before.map((l) => l.run), ['coordinator-1.0b']);
  assert.deepEqual(c.after.map((l) => [l.run, l.status]), [['coordinator-1.0d', 'pass']]);
  assert.deepEqual(c.final, { run: 'coordinator-1.0d', status: 'pass', outcome: 'partial' });
  assert.equal(c.rounds, 4);
  assert.equal(chainOf(runs, 'coordinator-1.0', 'c11').after[0].status, 'pass', 'the parent sees the final outcome');
  assert.equal(chainOf(runs, 'coordinator-1.0', 'c19'), null, 'a unit on its own has no chain');
  assert.equal(chainLine(chainOf(runs, 'coordinator-1.0d', 'c14')), 'continues coordinator-1.0b (1 try, stopped) → coordinator-1.0c (2 tries, stopped)');
});

test('a run whose other end is not loaded still shows the link', () => {
  const [parent] = real();
  const c = chainOf([parent], 'coordinator-1.0', 'c11');
  assert.deepEqual(c.after, [{ run: 'coordinator-1.0b', unit: 'c11', known: false, status: null, stopReason: null, rounds: [], outcome: null }]);
  assert.equal(chainLine(c), 'continued in coordinator-1.0b (not here)');
});

test('stats count a chain as one unit: rounds added up, outcome from the last run', () => {
  const runs = real();
  const units = chainUnits(runs);
  assert.deepEqual(units.map((u) => [u.run, u.id, u.status, u.rounds]), [['coordinator-1.0', 'c19', 'pass', 1], ['coordinator-1.0b', 'c11', 'pass', 6], ['coordinator-1.0d', 'c14', 'pass', 4]]);
  const s = stats(runs);
  assert.deepEqual([s.units, s.stoppedShare, s.medianRoundsToPass], [3, 0, 4]);
  const before = stats(runs.map(({ continues, ...x }) => ({ ...x, units: x.units.map(({ continuedIn, ...u }) => u) })));
  assert.deepEqual([before.units, before.stoppedShare], [6, 0.5], 'without the links: six units, half stopped');
  // Only the closed parent: the follow-on is not counted, so the unit stays as it stood.
  assert.equal(stats([runs[0]]).stoppedShare, 0.5);
});

test('old runs without the fields load and count as before', () => {
  const old = mk('old', [{ id: 'u', status: 'stopped', rounds: r(2) }]);
  assert.equal(chainOf([old], 'old', 'u'), null);
  assert.equal(stats([old]).units, 1);
  const v = view(old, decide(old));
  assert.equal(v.units[0].chain, null);
  assert.equal(v.units[0].chainText, '');
  assert.equal(linkedRuns(old, () => { throw new Error('never called'); }).size, 1);
});

test('the view, the text HUD, the flow map and the coordinator page show the chain', () => {
  const runs = real(); const byId = new Map(runs.map((x) => [x.id, x]));
  const child = byId.get('coordinator-1.0d');
  const v = view(child, decide(child), Date.parse(T), { linked: linkedRuns(child, (id) => byId.get(id)) });
  assert.match(textView(v), /↔ continues coordinator-1\.0b \(1 try, stopped\) → coordinator-1\.0c \(2 tries, stopped\)/);
  const g = flowGraph(v, Date.parse(T));
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'run').map((n) => n.run), ['coordinator-1.0b', 'coordinator-1.0c']);
  assert.ok(g.edges.some((e) => e.kind === 'chain' && e.from === 'u:c14' && e.to === 'c:coordinator-1.0b' && e.dir === 'before'));
  const m = selfModel({ runs, nowMs: Date.parse(T) });
  assert.deepEqual(m.chains.map((c) => [c.unit, c.rounds, c.status, c.links.length]), [['c11', 6, 'pass', 2], ['c14', 4, 'pass', 3]]);
  assert.equal(m.stats.units, 3, 'finished units: each chain once');
  assert.match(selfText(m), /c11: coordinator-1\.0 \(3, stopped\) → coordinator-1\.0b \(3, pass\) · 6 rounds, pass/);
});

test('init --continues links both runs; freeze wants the unit; link --continues records it afterwards', () => {
  assert.equal(run('init', 'p', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1').code, 0);
  run('add', 'p', 'm1', '--bar', 'b'); run('add', 'p', 'm3', '--bar', 'b', '--after', 'm1'); run('freeze', 'p');
  run('start', 'p', 'm1'); run('built', 'p', 'm1'); run('verdict', 'p', 'm1', 'fail', '--score', '5', '--gap', 'x');
  const stops = run('next', 'p').out.units;
  assert.deepEqual(stops.map((u) => u.reason), ['budget: rounds', 'blocked: m1 stopped']);
  assert.match(run('init', 'c', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p:nope').err, /no unit nope in run p/);
  assert.match(run('init', 'c', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'gone:m3').err, /no run gone here/);
  assert.equal(run('init', 'c', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p:m3').code, 0);
  assert.deepEqual(state('c').continues, [{ run: 'p', unit: 'm3' }]);
  assert.equal(state('p').units[1].continuedIn[0].run, 'c', 'the parent records it too');
  run('add', 'c', 'other', '--bar', 'b');
  assert.match(run('freeze', 'c').err, /continues p:m3; add m3 under the same id/);
  run('add', 'c', 'm3', '--bar', 'b'); assert.equal(run('freeze', 'c').code, 0);
  assert.match(run('show', 'p').out, /↔ continued in c \(0 tries, open\)/);
  assert.match(readFileSync(join(dir, 'runs', 'c', 'units', 'm3.html'), 'utf8'), /Continues <a href="[^"]*p\/hud\.html">p<\/a>/);
  // A follow-on run made before the flag existed: linked afterwards, on a closed run too.
  run('init', 'c2', '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', 'c2', 'm1', '--bar', 'b');
  run('close', 'p', '--outcome', 'stopped', '--reason', 'finish in follow-on runs');
  assert.match(run('link', 'c2', 'm1', '--continues', 'p:m3').err, /keeps the unit's id/);
  assert.equal(run('link', 'c2', 'm1', '--continues', 'p:m1').code, 0);
  assert.equal(state('p').units[0].continuedIn[0].run, 'c2');
  assert.equal(run('link', 'c2', 'm1', '--continues', 'p:m1').code, 0, 'twice is a no-op');
  assert.equal(state('c2').continues.length, 1);
  assert.equal(state('p').units[0].continuedIn.length, 1);
});

test('extend: more rounds only for a round-budget stop, only with the person\'s approval, recorded as a decision', () => {
  run('init', 'e', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'e', 'm1', '--bar', 'b'); run('add', 'e', 'm2', '--bar', 'b'); run('freeze', 'e');
  for (const u of ['m1', 'm2']) { run('start', 'e', u); run('built', 'e', u); }
  run('verdict', 'e', 'm1', 'fail', '--score', '7', '--gap', 'one more pass'); run('next', 'e');
  assert.match(run('extend', 'e', 'm2', '--rounds', '1', '--reason', 'r').err, /m2 is judging/);
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r').err, /no approval from the person/);
  assert.match(run('extend', 'e', 'm1', '--rounds', '9', '--reason', 'r').err, /1-4/);
  run('ask', 'e', '--question', 'One more round for m1?', '--header', 'm1', '--option', 'yes|one more', '--option', 'no|stop it', '--unit', 'm1');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q1').err, /no answer from the person/);
  run('answer', 'e', 'q1', '--choice', 'yes', '--by', 'lead');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q1').err, /no answer from the person/, 'the lead cannot approve its own extension');
  run('answer', 'e', 'q1', '--choice', 'yes');
  assert.equal(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'close to the bar', '--answer', 'q1').code, 0);
  const s = state('e'); const m1 = s.units[0];
  assert.deepEqual([m1.status, m1.stopReason, m1.extraRounds], ['open', null, 1]);
  assert.match(s.notes.at(-1).text, /^m1: 1 more round \(now 2\), approved by the person \(q1: yes\): close to the bar$/);
  assert.equal(s.notes.at(-1).answers, 'q1');
  assert.equal(run('next', 'e').out.units[0].action, 'build');
  run('start', 'e', 'm1'); run('built', 'e', 'm1');
  assert.equal(run('verdict', 'e', 'm1', 'pass', '--evidence', 'suite green', '--score', '9').code, 0, 'the extended unit can pass');
  assert.equal(state('e').units[0].status, 'pass');
  // A person's note on the unit, after its last verdict, approves too.
  run('verdict', 'e', 'm2', 'fail', '--score', '6', '--gap', 'g'); run('next', 'e');
  run('note', 'e', '--kind', 'person', '--unit', 'm2', '--text', 'ok, one more for m2');
  assert.equal(run('extend', 'e', 'm2', '--rounds', '1', '--reason', 'person asked').code, 0);
  assert.match(state('e').notes.at(-1).text, /their note: ok, one more for m2/);
});

test('a unit with extra rounds stops at the raised cap', () => {
  const rising = [5, 6, 7].map((score, i) => ({ n: i + 1, verdict: 'fail', score, gap: `gap ${['alpha', 'beta', 'gamma'][i]}`, at: T }));
  const u = { id: 'm1', status: 'open', rounds: rising, extraRounds: 1, strategyChanges: 0, strategyAt: -1 };
  const x = mk('x', [u]);
  assert.equal(decideUnit(u, x, Date.parse(T)).action, 'build');
  assert.equal(decideUnit({ ...u, extraRounds: 0 }, x, Date.parse(T)).reason, 'budget: rounds');
  assert.equal(view(x, decide(x, Date.parse(T)), Date.parse(T)).units[0].maxRounds, 4);
});
