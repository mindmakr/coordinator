// A unit finished in a follow-on run (#36): the link on both runs, the pages,
// stats counting a chain once, and a person-approved extra round (`extend`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chainLine, chainOf, chainUnits, linkedRuns, parseContinues } from '../lib/chain.mjs';
import { answerRefusal, grantQuestion, grantRefusal, namedRounds, noteApproves, noteRefusal } from '../lib/approval.mjs';
import { text as argText } from '../lib/args.mjs';
import { decide, decideUnit, stats } from '../lib/rules.mjs';
import { selfModel, selfText } from '../lib/self.mjs';
import { flowGraph } from '../lib/maps.mjs';
import { flowSvg } from '../lib/mapsvg.mjs';
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
  assert.deepEqual(c.final, { run: 'coordinator-1.0d', unit: 'c14', status: 'pass', outcome: 'pass' });
  assert.equal(c.rounds, 4);
  assert.equal(chainOf(runs, 'coordinator-1.0', 'c11').after[0].status, 'pass', 'the parent sees the final outcome');
  assert.equal(chainOf(runs, 'coordinator-1.0', 'c19'), null, 'a unit on its own has no chain');
  assert.equal(chainLine(chainOf(runs, 'coordinator-1.0d', 'c14'), 'c14'), 'continues coordinator-1.0b (1 try, stopped) → coordinator-1.0c (2 tries, stopped)');
});

test('a run whose other end is not loaded still shows the link', () => {
  const [parent] = real();
  const c = chainOf([parent], 'coordinator-1.0', 'c11');
  assert.deepEqual(c.after, [{ run: 'coordinator-1.0b', unit: 'c11', known: false, status: null, stopReason: null, rounds: [], outcome: null }]);
  assert.equal(chainLine(c, 'c11'), 'continued in coordinator-1.0b (not here)');
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
  const svg = flowSvg(v, { unitHref: (id) => `units/${id}.html`, home: 'hud.html', runHref: (id) => `../${id}/hud.html` }, Date.parse(T));
  assert.match(svg, /<rect class="nd ref run"/, 'a run box is drawn as a run, not as another repo');
  assert.match(svg, /<i class="sw ref run" aria-hidden="true"><\/i>another run of this project/);
  assert.doesNotMatch(svg, /<rect class="nd ref cross"/);
  const m = selfModel({ runs, nowMs: Date.parse(T) });
  assert.deepEqual(m.chains.map((c) => [c.unit, c.rounds, c.status, c.links.length]), [['c11', 6, 'pass', 2], ['c14', 4, 'pass', 3]]);
  assert.equal(m.stats.units, 3, 'finished units: each chain once');
  assert.match(selfText(m), /c11: coordinator-1\.0 \(3, stopped\) → coordinator-1\.0b \(3, pass\) · 6 rounds, pass/);
});

test('init --continues links both runs; freeze wants the unit; link --continues records it afterwards', () => {
  assert.equal(run('init', 'p', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1').code, 0);
  run('add', 'p', 'm1', '--bar', 'b'); run('add', 'p', 'm3', '--bar', 'b', '--after', 'm1'); run('freeze', 'p');
  run('start', 'p', 'm1'); run('built', 'p', 'm1'); run('verdict', 'p', 'm1', 'fail', '--severity', 'high', '--score', '5', '--gap', 'x');
  const stops = run('next', 'p').out.units;
  assert.deepEqual(stops.map((u) => u.reason), ['budget: rounds', 'blocked: m1 stopped']);
  assert.match(run('init', 'c', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p:nope').err, /no unit nope in run p/);
  assert.match(run('init', 'c', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'gone:m3').err, /no run gone here/);
  assert.equal(run('init', 'c', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p:m3').code, 0);
  assert.deepEqual(state('c').continues, [{ run: 'p', unit: 'm3' }]);
  assert.equal(state('p').units[1].continuedIn[0].run, 'c', 'the parent records it too');
  run('add', 'c', 'other', '--bar', 'b');
  assert.match(run('freeze', 'c').err, /continues p:m3; add m3/);
  run('add', 'c', 'm3', '--bar', 'b'); assert.equal(run('freeze', 'c').code, 0);
  assert.match(run('show', 'p').out, /↔ continued in c \(0 tries, open\)/);
  assert.match(readFileSync(join(dir, 'runs', 'c', 'units', 'm3.html'), 'utf8'), /Continues <a href="[^"]*p\/hud\.html">p<\/a>/);
  // A follow-on run made before the flag existed: linked afterwards, on a closed run too.
  run('init', 'c2', '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', 'c2', 'm1', '--bar', 'b');
  run('close', 'p', '--outcome', 'stopped', '--reason', 'finish in follow-on runs');
  assert.match(run('link', 'c2', 'm1', '--continues', 'p:m3').err, /p:m3 is already continued in c; continue that run's unit instead/, 'no forks');
  assert.match(run('init', 'c3', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p:m3').err, /already continued in c/);
  assert.equal(run('link', 'c2', 'm1', '--continues', 'p:m1').code, 0);
  assert.equal(state('p').units[0].continuedIn[0].run, 'c2');
  assert.equal(run('link', 'c2', 'm1', '--continues', 'p:m1').code, 0, 'twice is a no-op');
  assert.equal(state('c2').continues.length, 1);
  assert.equal(state('p').units[0].continuedIn.length, 1);
});

test('extend: more rounds only for a round-budget stop, only with the person\'s explicit yes, quoted in the decision', () => {
  run('init', 'e', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'e', 'm1', '--bar', 'b'); run('add', 'e', 'm2', '--bar', 'b'); run('freeze', 'e');
  for (const u of ['m1', 'm2']) { run('start', 'e', u); run('built', 'e', u); }
  run('verdict', 'e', 'm1', 'fail', '--severity', 'high', '--score', '7', '--gap', 'one more pass'); run('next', 'e');
  assert.match(run('extend', 'e', 'm2', '--rounds', '1', '--reason', 'r').err, /m2 is judging/);
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r').err, /no approval from the person/);
  assert.match(run('extend', 'e', 'm1', '--rounds', '9', '--reason', 'r').err, /1-4/);
  // A question with no approving option never approves.
  run('ask', 'e', '--question', 'What next for m1?', '--header', 'm1', '--option', 'Yes|one more', '--option', 'No|stop it', '--unit', 'm1');
  run('answer', 'e', 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q1').err, /q1 marks no option as approving/);
  assert.match(run('ask', 'e', '--question', 'q', '--header', 'h', '--option', 'Yes|a', '--option', 'No|b', '--approves', 'Maybe').err, /--approves must name one of the options/);
  run('ask', 'e', '--question', 'One more round for m1?', '--header', 'm1', '--option', 'Yes|one more', '--option', 'No|stop it', '--unit', 'm1', '--approves', 'Yes');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q2').err, /q2 has no answer yet/);
  run('answer', 'e', 'q2', '--choice', 'No', '--by', 'person', '--confirm', 'No, stop m1');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q2').err, /q2 was answered "No", not "Yes"/, 'No never approves');
  run('answer', 'e', 'q2', '--other', 'Yes but only if it is quick', '--by', 'person', '--confirm', 'Yes but only if it is quick');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q2').err, /not "Yes"/, 'free text never approves');
  run('answer', 'e', 'q2', '--choice', 'Yes');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q2').err, /not given by the person on the dashboard or the web/, 'the lead cannot answer for the person');
  run('answer', 'e', 'q2', '--choice', 'Yes', '--by', 'lead');
  assert.match(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'r', '--answer', 'q2').err, /not given by the person/);
  assert.match(run('answer', 'e', 'q2', '--choice', 'Yes', '--confirm', 'yes').err, /--confirm needs an explicit --by person/);
  assert.equal(run('answer', 'e', 'q2', '--choice', 'Yes', '--by', 'person', '--confirm', 'Yes, give m1 one more round').code, 0);
  assert.equal(run('extend', 'e', 'm1', '--rounds', '1', '--reason', 'close to the bar', '--answer', 'q2').code, 0);
  const s = state('e'); const m1 = s.units[0];
  assert.deepEqual([m1.status, m1.stopReason, m1.extraRounds], ['open', null, 1]);
  assert.equal(s.notes.at(-1).text, 'm1: 1 more round (now 2; their words name 1), approved by the person (q2 "m1: One more round for m1?" answered "Yes (one more)" via cli, their words: "Yes, give m1 one more round"): close to the bar');
  assert.equal(s.notes.at(-1).answers, 'q2');
  assert.equal(run('next', 'e').out.units[0].action, 'build');
  run('start', 'e', 'm1'); run('built', 'e', 'm1');
  assert.equal(run('verdict', 'e', 'm1', 'pass', '--evidence', 'suite green', '--score', '9').code, 0, 'the extended unit can pass');
  assert.equal(state('e').units[0].status, 'pass');
  // A person's note: only a clear "approved", and only from the person.
  run('verdict', 'e', 'm2', 'fail', '--severity', 'high', '--score', '6', '--gap', 'g'); run('next', 'e');
  run('note', 'e', '--kind', 'person', '--unit', 'm2', '--text', 'Approved: one more round for m2');
  assert.match(run('extend', 'e', 'm2', '--rounds', '1', '--reason', 'r').err, /not added by the person on the dashboard or the web/);
  for (const t of ['No, not approved', 'ok, one more for m2', 'Approved?', 'Approved, but only if quick', "I don't approve"]) {
    run('note', 'e', '--kind', 'person', '--unit', 'm2', '--text', t, '--confirm');
    assert.match(run('extend', 'e', 'm2', '--rounds', '1', '--reason', 'r').err, /does not clearly approve/, t);
  }
  run('note', 'e', '--kind', 'person', '--unit', 'm2', '--text', 'Approved: one more round for m2', '--confirm');
  assert.equal(run('extend', 'e', 'm2', '--rounds', '1', '--reason', 'person asked').code, 0);
  assert.match(state('e').notes.at(-1).text, /approved by the person \(their note via cli: "Approved: one more round for m2"\): person asked$/);
});

test('extend: one approval, one use; only after the last verdict; on the named unit; rounds only as many as their words name', () => {
  const stop = (u) => { run('start', 'x', u); run('built', 'x', u); run('verdict', 'x', u, 'fail', '--severity', 'high', '--score', '5', '--gap', `gap ${Math.random()}`); run('next', 'x'); };
  run('init', 'x', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'x', 'm1', '--bar', 'b'); run('add', 'x', 'm2', '--bar', 'b'); run('freeze', 'x');
  // Answered before the unit's last verdict: stale.
  run('start', 'x', 'm1'); run('built', 'x', 'm1');
  run('ask', 'x', '--question', 'More for m1?', '--header', 'm1', '--option', 'Yes|one more', '--option', 'No|stop', '--unit', 'm1', '--approves', 'Yes');
  run('answer', 'x', 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes, one more');
  run('verdict', 'x', 'm1', 'fail', '--severity', 'high', '--score', '5', '--gap', 'g1'); run('next', 'x');
  assert.match(run('extend', 'x', 'm1', '--reason', 'r', '--answer', 'q1').err, /answered before m1's last verdict; ask again/);
  // A question that names no unit, or another unit, approves nothing here.
  run('ask', 'x', '--question', 'More rounds?', '--header', 'any', '--option', 'Yes|one more', '--option', 'No|stop', '--approves', 'Yes');
  run('answer', 'x', 'q2', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
  assert.match(run('extend', 'x', 'm1', '--reason', 'r', '--answer', 'q2').err, /q2 names no unit; an approving question must name m1/);
  run('ask', 'x', '--question', 'More for m2?', '--header', 'm2', '--option', 'Yes|one more', '--option', 'No|stop', '--unit', 'm2', '--approves', 'Yes');
  run('answer', 'x', 'q3', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
  assert.match(run('extend', 'x', 'm1', '--reason', 'r', '--answer', 'q3').err, /q3 is about m2/);
  // "One more" is one round; its approval works once.
  run('ask', 'x', '--question', 'One more for m1?', '--header', 'm1', '--option', 'Yes|one more round', '--option', 'No|stop', '--unit', 'm1', '--approves', 'Yes');
  run('answer', 'x', 'q4', '--choice', 'Yes', '--by', 'person', '--confirm', 'Yes, one more');
  assert.match(run('extend', 'x', 'm1', '--rounds', '3', '--reason', 'r', '--answer', 'q4').err, /--rounds 3, but the approval names 1/);
  assert.equal(run('extend', 'x', 'm1', '--reason', 'r', '--answer', 'q4').code, 0);
  assert.equal(state('x').units[0].extraRounds, 1);
  assert.match(run('extend', 'x', 'm1', '--reason', 'again', '--answer', 'q4').err, /extend refused/, 'not at the cap any more');
  stop('m1');
  assert.match(run('extend', 'x', 'm1', '--reason', 'again', '--answer', 'q4').err, /q4 is already decided; one approval is good for one extend/);
  assert.equal(state('x').units[0].extraRounds, 1, 'one yes, one round');
  // An option that names two rounds allows two, and the decision says so.
  run('ask', 'x', '--question', 'How many more for m1?', '--header', 'm1', '--option', 'Two more|two more rounds', '--option', 'No|stop', '--unit', 'm1', '--approves', 'Two more');
  run('answer', 'x', 'q5', '--choice', 'Two more', '--by', 'person', '--confirm', 'two more, then stop');
  assert.equal(run('extend', 'x', 'm1', '--rounds', '2', '--reason', 'r', '--answer', 'q5').code, 0);
  assert.match(state('x').notes.at(-1).text, /^m1: 2 more rounds \(now 4; their words name 2\)/);
  // A note is used once too, and with no number it is one round.
  stop('m2');
  run('note', 'x', '--kind', 'person', '--unit', 'm2', '--text', 'Approved', '--confirm');
  assert.match(run('extend', 'x', 'm2', '--rounds', '2', '--reason', 'r').err, /names no single number, so it is for one round/);
  assert.equal(run('extend', 'x', 'm2', '--reason', 'r').code, 0);
  assert.match(state('x').notes.at(-1).text, /their words name no single number: one round/);
  stop('m2');
  assert.match(run('extend', 'x', 'm2', '--reason', 'r').err, /no approval from the person since m2's last verdict/);
});

test('extend: a hand edit of state.json never approves', () => {
  const file = join(dir, 'runs', 'h', 'state.json');
  const edit = (fn) => { const st = JSON.parse(readFileSync(file, 'utf8')); fn(st); writeFileSync(file, JSON.stringify(st)); };
  run('init', 'h', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'h', 'm1', '--bar', 'b'); run('freeze', 'h');
  run('start', 'h', 'm1'); run('built', 'h', 'm1'); run('verdict', 'h', 'm1', 'fail', '--severity', 'high', '--score', '5', '--gap', 'g'); run('next', 'h');
  run('ask', 'h', '--question', 'One more for m1?', '--header', 'm1', '--option', 'Yes|one more', '--option', 'No|stop', '--unit', 'm1', '--approves', 'Yes');
  run('answer', 'h', 'q1', '--choice', 'Yes'); // the lead's CLI answer: via cli, no confirm
  assert.match(run('extend', 'h', 'm1', '--reason', 'r', '--answer', 'q1').err, /not given by the person/);
  edit((st) => { st.notes.find((n) => n.kind === 'question').history.at(-1).via = 'dashboard'; });
  assert.match(run('extend', 'h', 'm1', '--reason', 'r', '--answer', 'q1').err, /q1's answer was last written by state\.edited, not by answer/);
  // The next write records the edit in the log as state.edited; still refused.
  run('note', 'h', '--kind', 'info', '--text', 'any later change');
  assert.ok(readFileSync(join(dir, 'runs', 'h', 'events.jsonl'), 'utf8').includes('"state.edited"'));
  assert.match(run('extend', 'h', 'm1', '--reason', 'r', '--answer', 'q1').err, /last written by state\.edited/);
  // A hand-added approving note from "the web", and a hand-edited approving option.
  edit((st) => { st.notes.push({ kind: 'person', text: 'Approved', unit: 'm1', via: 'web', at: new Date().toISOString() }); });
  assert.match(run('extend', 'h', 'm1', '--reason', 'r').err, /their note was last written by state\.edited, not by note/);
  run('ask', 'h', '--question', 'One more for m1?', '--header', 'm1', '--option', 'Yes|one more', '--option', 'No|stop', '--unit', 'm1');
  run('answer', 'h', 'q2', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
  edit((st) => { st.notes.filter((n) => n.kind === 'question')[1].approves = 'Yes'; });
  assert.match(run('extend', 'h', 'm1', '--reason', 'r', '--answer', 'q2').err, /q2 was last written by state\.edited, not by question/);
  assert.equal(state('h').units[0].status, 'stopped');
});

// f5 round 2 (both critics): a hand edit of the question's text to "Give it 30 more minutes?" or its header
// to "30 min", on a question storing 600, still granted 600.
test('extend <run>: a hand-edited question text or header never approves, and the refusal records nothing', () => {
  let n = 0;
  const probe = (edit, re, why) => {
    const id = `he${(n += 1)}`;
    const file = join(dir, 'runs', id, 'state.json');
    run('init', id, '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
    run('add', id, 'm1', '--bar', 'b'); run('freeze', id);
    const a = run('ask', id, '--question', 'Give the run 600 more minutes?', '--header', 'time', '--option', 'Yes', '--option', 'No|close it', '--approves', 'Yes', '--grant-minutes', '600');
    assert.equal(a.code, 0, a.err);
    run('answer', id, 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
    const st = JSON.parse(readFileSync(file, 'utf8')); edit(st.notes.find((x) => x.kind === 'question')); writeFileSync(file, JSON.stringify(st));
    const before = state(id).notes.length;
    const r = run('extend', id, '--reason', 'r', '--answer', 'q1');
    assert.notEqual(r.code, 0, why); assert.match(r.err, re, why);
    const s = state(id);
    assert.equal(s.budget.maxMinutes, 60, `${why}: no minutes added`); assert.equal(s.budget.addedMinutes ?? 0, 0, why);
    assert.equal(s.notes.length, before, `${why}: no decision logged`);
    assert.equal(s.notes.find((x) => x.kind === 'question').usedAt ?? null, null, `${why}: the answer is not used up`);
  };
  // The critics' probes: the field check ask runs is run again on the stored question, whoever wrote it.
  probe((q) => { q.text = 'Give it 30 more minutes?'; }, /extend refused: q1: the question names an amount other than 600 minutes: "30"/, 'text');
  probe((q) => { q.header = '30 min'; }, /extend refused: q1: the header names an amount other than 600 minutes: "30"/, 'header');
  probe((q) => { q.options[1].description = 'just 30 more minutes'; }, /extend refused: q1: option "No" names an amount other than 600 minutes: "30"/, 'option');
  // An edit naming no amount: refused because a hand edit wrote it.
  probe((q) => { q.text = 'Keep going?'; }, /q1 was last written by state\.edited, not by question/, 'text, no amount');
  probe((q) => { q.header = 'urgent'; }, /q1 was last written by state\.edited, not by question/, 'header, no amount');
});

// f5 round 2 (finding 2): "Give it \u202e600\u202c more minutes?" displayed as "006".
test('ask: text-direction overrides and zero-width characters are stripped from the question, header and options', () => {
  const hidden = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b\u200c\u200d\u200e\u200f\ufeff';
  assert.equal(argText(`Give it \u202e600\u202c more minutes?${hidden}`, 'question'), 'Give it 600 more minutes?');
  assert.equal(argText(`6\u200b0\u200d0`, 'x'), '600');
  assert.throws(() => argText(hidden, 'header'), /missing --header/);
  run('init', 'bd', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 'bd', 'm1', '--bar', 'b'); run('freeze', 'bd');
  const a = run('ask', 'bd', '--question', 'Give it \u202e600\u202c more minutes?', '--header', 't\u200bime', '--option', 'Y\u202ees', '--option', 'No|close \u2066it\u2069', '--approves', 'Yes', '--grant-minutes', '600');
  assert.equal(a.code, 0, a.err);
  const q = state('bd').notes.find((x) => x.kind === 'question');
  assert.equal(q.text, 'Give it 600 more minutes?'); assert.equal(q.header, 'time');
  assert.deepEqual(q.options, [{ label: 'Yes', description: '600 more minutes' }, { label: 'No', description: 'close it' }]);
});

test('ask: a soft hyphen and a word joiner are stripped from the question', () => {
  run('init', 'sh', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 'sh', 'm1', '--bar', 'b'); run('freeze', 'sh');
  const a = run('ask', 'sh', '--question', 'More' + '\u00ad' + ' time' + '\u2060' + '?', '--header', 'h', '--option', 'Yes', '--option', 'No');
  assert.equal(a.code, 0, a.err);
  assert.equal(state('sh').notes.find((x) => x.kind === 'question').text, 'More time?');
});

test('grantQuestion: every field of a stored question, the one check ask and extend share', () => {
  const q = { text: 'Give the run 600 more minutes?', header: 'time', approves: 'Yes', options: [{ label: 'Yes', description: '600 more minutes' }, { label: 'No', description: 'close it' }] };
  assert.deepEqual(grantQuestion(q, 600), q.options);
  assert.deepEqual(grantQuestion({ ...q, options: [{ label: 'Yes', description: null }, q.options[1]] }, 600)[0], { label: 'Yes', description: '600 more minutes' });
  assert.throws(() => grantQuestion({ ...q, text: 'Give it 30 more minutes?' }, 600), /^Error: the question names an amount other than 600 minutes: "30"$/);
  assert.throws(() => grantQuestion({ ...q, header: '30 min' }, 600), /^Error: the header names an amount other than 600 minutes: "30"$/);
  assert.throws(() => grantQuestion({ ...q, options: [{ label: 'Yes', description: 'more time' }, q.options[1]] }, 600), /the approving option "Yes" must state "600 more minutes"/);
  assert.throws(() => grantQuestion({ ...q, options: [q.options[0], { label: 'No', description: 'an hour' }] }, 600), /option "No" names an amount other than 600 minutes: "hour"/);
  assert.throws(() => grantQuestion({ ...q, header: undefined, text: 'Give it an hour?' }, 600), /the question names/);
});

test('the --confirm words pass the same yes check as a note', () => {
  run('init', 'cf', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'cf', 'm1', '--bar', 'b'); run('freeze', 'cf');
  run('start', 'cf', 'm1'); run('built', 'cf', 'm1'); run('verdict', 'cf', 'm1', 'fail', '--severity', 'high', '--score', '5', '--gap', 'g'); run('next', 'cf');
  run('ask', 'cf', '--question', 'One more for m1?', '--header', 'm1', '--option', 'Yes|one more', '--option', 'No|stop', '--unit', 'm1', '--approves', 'Yes');
  for (const words of ['No, stop it', 'yes once PR 1234 lands', 'yes but later', 'yes?']) {
    run('answer', 'cf', 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', words);
    assert.match(run('extend', 'cf', 'm1', '--reason', 'r', '--answer', 'q1').err, /confirmed words do not clearly say yes/, words);
  }
  run('answer', 'cf', 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', 'approved once PR 1234 lands');
  assert.match(run('extend', 'cf', 'm1', '--rounds', '4', '--reason', 'r', '--answer', 'q1').err, /confirmed words do not clearly say yes/);
  run('answer', 'cf', 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', 'Yes, go ahead with PR 1234');
  assert.match(run('extend', 'cf', 'm1', '--rounds', '4', '--reason', 'r', '--answer', 'q1').err, /--rounds 4, but the approval names 1/, 'PR 1234 is no round count');
  assert.equal(run('extend', 'cf', 'm1', '--reason', 'r', '--answer', 'q1').code, 0);
});

// hud-facelift: a session restart cost 25 minutes and no command could give the run that time back.
test('extend <run>: more time only on the person\'s approving answer, exactly the minutes the question stores', () => {
  run('init', 't', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 't', 'm1', '--bar', 'b'); run('add', 't', 'm2', '--bar', 'b'); run('freeze', 't');
  run('start', 't', 'm1'); run('built', 't', 'm1'); run('verdict', 't', 'm1', 'pass', '--evidence', 'green', '--score', '9');
  // Past the budget: next would stop m2, which never started.
  const file = join(dir, 'runs', 't', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8')); st.createdAt = new Date(Date.now() - 70 * 60_000).toISOString(); writeFileSync(file, JSON.stringify(st));
  assert.equal(run('next', 't').out.units.find((u) => u.id === 'm2').reason, 'budget: time');
  // Refused without an approving answer from the person.
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r').err, /more time needs --answer qN/);
  run('ask', 't', '--question', 'More time?', '--header', 'time', '--option', 'Yes|60 more minutes', '--option', 'No|close it');
  run('answer', 't', 'q1', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r', '--answer', 'q1').err, /q1 marks no option as approving/);
  const q2 = run('ask', 't', '--question', 'Give the run 60 more minutes?', '--header', 'time', '--option', 'Yes', '--option', 'No|close it', '--approves', 'Yes', '--grant-minutes', '60');
  assert.equal(q2.code, 0, q2.err);
  const asked = state('t').notes.filter((n) => n.kind === 'question')[1];
  assert.equal(asked.grantMinutes, 60, 'the amount is stored on the question');
  assert.deepEqual(asked.options[0], { label: 'Yes', description: '60 more minutes' }, 'the approving option states it');
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r', '--answer', 'q2').err, /q2 has no answer yet/);
  run('answer', 't', 'q2', '--choice', 'No', '--by', 'person', '--confirm', 'No, close it');
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r', '--answer', 'q2').err, /q2 was answered "No", not "Yes"/);
  run('answer', 't', 'q2', '--choice', 'Yes');
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r', '--answer', 'q2').err, /not given by the person/, 'the lead cannot answer for the person');
  run('answer', 't', 'q2', '--choice', 'Yes', '--by', 'person', '--confirm', 'Yes, but only if it is quick');
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r', '--answer', 'q2').err, /do not clearly say yes/);
  // A question on a unit approves nothing for the run; --rounds goes with a unit, --minutes with the run.
  run('ask', 't', '--question', 'More for m2?', '--header', 'm2', '--option', 'Yes|one more round', '--option', 'No|stop', '--unit', 'm2', '--approves', 'Yes');
  run('answer', 't', 'q3', '--choice', 'Yes', '--by', 'person', '--confirm', 'yes');
  assert.match(run('extend', 't', '--minutes', '30', '--reason', 'r', '--answer', 'q3').err, /q3 is about m2/);
  assert.match(run('extend', 't', 'm2', '--minutes', '30', '--reason', 'r', '--answer', 'q3').err, /--minutes goes with the run/);
  assert.match(run('extend', 't', '--minutes', '30', '--rounds', '1', '--reason', 'r', '--answer', 'q2').err, /--rounds goes with a unit/);
  // The question stores 60: more is refused; nothing was recorded by any refusal.
  run('answer', 't', 'q2', '--choice', 'Yes', '--by', 'person', '--confirm', 'Yes, go ahead');
  assert.match(run('extend', 't', '--minutes', '90', '--reason', 'r', '--answer', 'q2').err, /--minutes 90, but q2 grants 60/);
  assert.equal(state('t').budget.maxMinutes, 60);
  // Approved: exactly that many minutes, logged as a decision with their words; the time-stopped unit opens again.
  assert.equal(run('extend', 't', '--reason', 'session restart cost 25 minutes', '--answer', 'q2').code, 0);
  const s = state('t');
  assert.equal(s.budget.maxMinutes, 120); assert.equal(s.budget.addedMinutes, 60);
  const d = s.notes.at(-1);
  assert.equal(d.kind, 'decision'); assert.equal(d.answers, 'q2');
  assert.match(d.text, /^run time budget: 60 more minutes \(now 120, was 60; 7\d used; q2 grants 60\), approved by the person \(q2 "time: Give the run 60 more minutes\?" answered "Yes \(60 more minutes\)" via cli, their words: "Yes, go ahead"\): session restart cost 25 minutes$/);
  const m2 = run('next', 't').out.units.find((u) => u.id === 'm2');
  assert.equal(m2.action, 'build', 'm2 is no longer past the budget');
  // One approval, one use.
  assert.match(run('extend', 't', '--minutes', '10', '--reason', 'r', '--answer', 'q2').err, /q2 is already decided/);
});

test('ask --grant-minutes: a whole number stored on a run question with an approving option that states it', () => {
  run('init', 'ga', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 'ga', 'm1', '--bar', 'b'); run('freeze', 'ga');
  const ask = (...extra) => run('ask', 'ga', '--question', 'More time?', '--header', 'time', '--option', 'No|close it', ...extra);
  for (const n of ['0', '1.5', 'abc', '1441']) assert.match(ask('--option', 'Yes', '--approves', 'Yes', '--grant-minutes', n).err, /--grant-minutes: expected a whole number 1-1440/, n);
  assert.match(ask('--option', 'Yes', '--grant-minutes', '60').err, /--grant-minutes goes with --approves/);
  assert.match(ask('--option', 'Yes', '--approves', 'Yes', '--grant-minutes', '60', '--unit', 'm1').err, /--grant-minutes is for the run's time: a question on a unit grants rounds/);
  // The option's own text must say the same amount, and nothing else.
  assert.match(ask('--option', 'Yes|90 more minutes', '--approves', 'Yes', '--grant-minutes', '60').err, /the approving option "Yes" must state "60 more minutes"/);
  assert.match(ask('--option', 'Yes|an hour', '--approves', 'Yes', '--grant-minutes', '60').err, /must state "60 more minutes"/);
  assert.match(ask('--option', 'Yes|60 more minutes (the run is 45 minutes over)', '--approves', 'Yes', '--grant-minutes', '60').err, /the approving option "Yes" names an amount other than 60 minutes: "45"/);
  assert.match(ask('--option', 'Yes 2|60 more minutes', '--approves', 'Yes 2', '--grant-minutes', '60').err, /names an amount other than 60 minutes: "2"/);
  assert.equal(state('ga').notes.filter((n) => n.kind === 'question').length, 0, 'no refused question was stored');
  assert.equal(ask('--option', 'Yes|keep going, 45 more minutes', '--approves', 'Yes', '--grant-minutes', '45').code, 0);
  assert.equal(JSON.parse(run('questions', 'ga').out)[0].grantMinutes, 45, 'questions shows the amount');
});

// Round-2 critic, f4 (E5): natural wordings granted more than was approved. Each is now refused, or grants exactly the stored amount.
test('extend <run>: the critic\'s probe wordings are refused or grant exactly the stored amount', () => {
  run('init', 'cx', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 'cx', 'm1', '--bar', 'b'); run('freeze', 'cx');
  let n = 0;
  const approve = (options, confirm, grant, extend = true) => {
    const r = run('ask', 'cx', '--question', 'More time?', '--header', 'time', ...options.flatMap((o) => ['--option', o]), '--approves', 'Yes', ...(grant ? ['--grant-minutes', String(grant)] : []));
    if (r.code !== 0) return { asked: r.err };
    n += 1; const id = `q${n}`;
    run('answer', 'cx', id, '--choice', 'Yes', '--by', 'person', '--confirm', confirm);
    return { id, ...(extend ? run('extend', 'cx', '--reason', 'probe', '--answer', id) : {}) };
  };
  // An amount only in the option's text (no stored amount): refused for run time, whatever it says.
  for (const o of ['Yes|.5 hours', 'Yes|1,5 hours', 'Yes|quarter of an hour', 'Yes|30-45 more minutes', 'Yes|between 30 and 60 minutes', 'Yes|keep going (the run is 45 minutes over)', 'Yes|60 more minutes', 'Yes|a hundred and twenty minutes']) {
    const r = approve([o, 'No|close it'], 'Yes');
    assert.match(r.err, new RegExp(`extend refused: ${r.id} stores no amount of time: ask again with --grant-minutes N`), o);
  }
  // The same wordings with a stored amount: the ask is refused when the option's text says another amount.
  for (const o of ['Yes|.5 hours', 'Yes|1,5 hours', 'Yes|quarter of an hour', 'Yes|30-45 more minutes', 'Yes|between 30 and 60 minutes', 'Yes|a hundred and twenty minutes', 'Yes|30 more minutes (the run is 45 minutes over)']) {
    assert.match(approve([o, 'No|close it'], 'Yes', 30).asked, /ask refused|the approving option/, o);
  }
  assert.equal(state('cx').budget.maxMinutes, 60, 'nothing added so far');
  // Their confirmed words name another amount: refused, never read as one.
  for (const c of ['Yes, but only 30', 'Yes, only 30', 'Yes, extend it to 2 hours', 'Yes, a hundred and twenty minutes', 'Yes, .5 hours', 'Yes, 1,5 hours', 'Yes, a quarter of an hour', 'Yes, 30-45 more minutes', 'Yes, between 30 and 60 minutes', 'Yes, half an hour', 'Yes, another hour', 'Yes, thirty more', 'Yes, extend it to 60 minutes']) {
    const r = approve(['Yes|60 more minutes', 'No|close it'], c, 60);
    assert.match(r.err, /extend refused: q\d+'s confirmed words (do not clearly say yes|name an amount other than the 60 minutes it grants|name a total)/, c);
  }
  assert.equal(state('cx').budget.maxMinutes, 60, 'no refusal recorded anything');
  // Their words agree: exactly the stored amount, never more; --minutes may give fewer.
  let r = approve(['Yes|60 more minutes', 'No|close it'], 'Yes, sixty more minutes', 60);
  assert.equal(r.code, 0, r.err);
  assert.equal(state('cx').budget.maxMinutes, 120);
  r = approve(['Yes|60 more minutes (the run is over)', 'No|close it'], 'Yes, 60 more minutes', 60);
  assert.equal(r.code, 0, r.err);
  assert.equal(state('cx').budget.maxMinutes, 180);
  r = approve(['Yes|45 more minutes', 'No|close it'], 'go ahead', 45, false);
  assert.match(run('extend', 'cx', '--reason', 'r', '--answer', r.id, '--minutes', '46').err, /--minutes 46, but q\d+ grants 45/);
  assert.equal(run('extend', 'cx', '--reason', 'r', '--answer', r.id, '--minutes', '20').code, 0);
  const s = state('cx');
  assert.equal(s.budget.maxMinutes, 200); assert.equal(s.budget.addedMinutes, 140);
  assert.match(s.notes.at(-1).text, /^run time budget: 20 more minutes \(now 200, was 180; \d+ used; q\d+ grants 45; 20 added\), approved by the person \(.*their words: "go ahead"\): r$/);
});

// Round-3 critic, f5 (E10, finding 1): only the approving option was checked against N. The question, the header and
// every option's label and description are now checked: another amount of time anywhere refuses the ask, which records nothing.
test('ask --grant-minutes N: the question, the header and every option name no amount of time but N minutes', () => {
  run('init', 'gq', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 'gq', 'm1', '--bar', 'b'); run('freeze', 'gq');
  const ask = ({ question = 'More time?', header = 'time', yes = 'Yes', no = 'No|close it', grant = '60' } = {}) => run('ask', 'gq', '--question', question, '--header', header, '--option', yes, '--option', no, '--approves', yes.split('|')[0], '--grant-minutes', grant);
  // The critic's probes.
  assert.match(ask({ question: 'Give it 30 more minutes?', yes: 'Yes', grant: '600' }).err, /ask refused: the question names an amount other than 600 minutes: "30"/);
  assert.match(ask({ header: '60 min', grant: '600' }).err, /ask refused: the header names an amount other than 600 minutes: "60"/);
  assert.match(ask({ no: 'No|30 more minutes' }).err, /ask refused: option "No" names an amount other than 60 minutes: "30"/);
  // Per field, each kind of amount: digits, number words, fractions, hours, seconds, a range.
  const probes = [
    ['digits', '30 more minutes', '30'], ['other digits', '３０ more minutes', '30'], ['Arabic-Indic digits', '٣٠ more minutes', '٣٠'],
    ['number words', 'thirty more minutes', 'thirty'], ['fraction', 'half an hour', 'half'], ['fraction sign', '½ hour', '1'],
    ['hours', 'an hour more', 'hour'], ['1h', 'another 1h', '1h'], ['seconds', '60 seconds more', 'seconds'], ['90s', 'another 90s', '90s'],
    ['range', '45-90 minutes', '45'], ['range in words', 'sixty to ninety minutes', 'ninety'], ['days', 'a day more', 'day'],
  ];
  const fields = (t) => [
    ['the question', { question: `Give it ${t}?` }],
    ...(t.length <= 12 ? [['the header', { header: t }]] : []), // a header is 12 characters at most
    [`the approving option "Yes ${t}"`, { yes: `Yes ${t}` }], // its description is then written for you: "60 more minutes"
    ['the approving option "Yes"', { yes: `Yes|60 more minutes (${t})` }],
    [`option "No ${t}"`, { no: `No ${t}|close it` }],
    ['option "No"', { no: `No|not ${t}` }],
  ];
  let headers = 0;
  for (const [kind, t, hit] of probes) {
    for (const [field, o] of fields(t)) {
      if (field === 'the header') headers += 1;
      const r = ask(o);
      assert.notEqual(r.code, 0, `${kind} in ${field}`);
      assert.ok(r.err.includes(`ask refused: ${field} names an amount other than 60 minutes: "${hit}"`), `${kind} in ${field}: ${r.err}`);
    }
  }
  assert.ok(headers >= 6, 'the header is probed with most kinds');
  // A total in the question: refused too.
  assert.match(ask({ question: 'Extend the run to 60 minutes?' }).err, /ask refused: the question names a total \("to 60"\)/);
  assert.equal(state('gq').notes.filter((n) => n.kind === 'question').length, 0, 'no refused question was stored');
  // N itself, in digits or words, and text with no amount: accepted.
  const ok = ask({ question: 'The run has used its time. Give it sixty more minutes?', header: '60 min', no: 'No|close the run' });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(state('gq').notes.filter((n) => n.kind === 'question').length, 1);
});

// Round-3 critic, f5 (E10, findings 2-4): confirmed words asking for less, in another unit, or with other digits granted N.
test('extend <run>: confirmed words asking for less, in seconds or hours, or with any number but N are refused', () => {
  run('init', 'cl', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-minutes', '60');
  run('add', 'cl', 'm1', '--bar', 'b'); run('freeze', 'cl');
  let n = 0;
  const approve = (confirm) => {
    assert.equal(run('ask', 'cl', '--question', 'More time?', '--header', 'time', '--option', 'Yes', '--option', 'No|close it', '--approves', 'Yes', '--grant-minutes', '60').code, 0);
    n += 1; const id = `q${n}`;
    run('answer', 'cl', id, '--choice', 'Yes', '--by', 'person', '--confirm', confirm);
    return run('extend', 'cl', '--reason', 'probe', '--answer', id);
  };
  const cases = [
    // Asking for less.
    ['Yes, a bit less please', /ask for less than the 60 minutes it grants \("less"\)/],
    ['Yes, fewer minutes', /ask for less than the 60 minutes it grants \("fewer"\)/],
    ['Yes, but shorter', /do not clearly say yes|ask for less/],
    ['Yes, a shorter extension', /ask for less than the 60 minutes it grants \("shorter"\)/],
    ['Yes, only some of it', /ask for less than the 60 minutes it grants \("only"\)/],
    ['Yes, some more time', /ask for less than the 60 minutes it grants \("some"\)/],
    ['Yes, just a little', /ask for less than the 60 minutes it grants \("little"\)/],
    ['Yes, part of it', /ask for less than the 60 minutes it grants \("part"\)/],
    ['Yes, partly', /ask for less than the 60 minutes it grants \("partly"\)/],
    ['Yes, half of it', /name an amount other than the 60 minutes it grants: "half"/],
    ['Yes, halfway', /ask for less than the 60 minutes it grants \("halfway"\)/],
    ['Yes, only that', /ask for less than the 60 minutes it grants \("only"\)/],
    // Another unit.
    ['Yes, 60 seconds is fine', /name an amount other than the 60 minutes it grants: "seconds"/],
    ['Yes, 60 secs', /name an amount other than the 60 minutes it grants: "secs"/],
    ['Yes, 60s', /name an amount other than the 60 minutes it grants: "60s"/],
    ['Yes, 60 hours', /name an amount other than the 60 minutes it grants: "hours"/],
    ['Yes, 1 hr', /name an amount other than the 60 minutes it grants: "1"/],
    // Other digits and number words.
    ['Yes, ３０ minutes', /name an amount other than the 60 minutes it grants: "30"/],
    ['Yes, ٣٠ minutes', /name an amount other than the 60 minutes it grants: "٣٠"/],
    ['Yes, ३० minutes', /name an amount other than the 60 minutes it grants: "३०"/],
    ['Yes, ½', /name an amount other than the 60 minutes it grants: "1"/],
    ['Yes, forty minutes', /name an amount other than the 60 minutes it grants: "forty"/],
    ['Yes, ninety', /name an amount other than the 60 minutes it grants: "ninety"/],
  ];
  for (const [c, why] of cases) {
    const r = approve(c);
    assert.notEqual(r.code, 0, c);
    assert.match(r.err, /extend refused: q\d+'s confirmed words /, c);
    assert.match(r.err, why, c);
  }
  assert.equal(state('cl').budget.maxMinutes, 60, 'no refusal recorded anything');
  // N in fullwidth digits is N; plain words grant exactly N.
  assert.equal(approve('Yes, ６０ more minutes').code, 0);
  assert.equal(approve('Yes, go ahead').code, 0);
  assert.equal(state('cl').budget.maxMinutes, 180);
});

test('the numbers in a person\'s words, against the amount a question grants', () => {
  for (const t of ['Yes', 'Yes, go ahead', 'Yes|60 more minutes', 'yes, sixty more minutes', '60 more minutes, approved', 'up to 60 more minutes']) assert.equal(grantRefusal(t, 60), null, t);
  for (const [t, hit] of [['Yes, but only 30', '30'], ['.5 hours', '.5'], ['1,5 hours', '1,5'], ['30-45 more minutes', '30'], ['between 30 and 60 minutes', '30'], ['the run is 45 minutes over', '45'], ['Yes, this one', 'one'], ['thirty more', 'thirty'], ['sixty-five minutes', 'sixty-five']]) {
    assert.equal(grantRefusal(t, 60), `name an amount other than the 60 minutes it grants: "${hit}"`, t);
  }
  for (const [t, hit] of [['quarter of an hour', 'quarter'], ['half an hour', 'half'], ['a hundred and twenty minutes', 'hundred'], ['a couple more hours', 'couple'], ['a few more minutes', 'few'], ['another hour', 'hour'], ['1h', '1h'], ['90m', '90'], ['another minute', 'another minute']]) {
    assert.equal(grantRefusal(t, 60), `name an amount other than the 60 minutes it grants: "${hit}"`, t);
  }
  assert.equal(grantRefusal('extend it to 60 minutes', 60), 'name a total ("to 60"), not an amount added');
  assert.equal(grantRefusal('60 minutes in total', 60), 'name a total ("total"), not an amount added');
});

test('the rounds an approval names', () => {
  assert.equal(namedRounds('Yes, one more round'), 1);
  assert.equal(namedRounds('two more rounds'), 2);
  assert.equal(namedRounds('give it 3 rounds'), 3);
  assert.equal(namedRounds('give it 3'), null, 'a bare number is not a round count');
  assert.equal(namedRounds('approved once PR 1234 lands'), null, 'nor is a PR number');
  assert.equal(namedRounds('5 more rounds'), null, 'only 1-4');
  assert.equal(namedRounds('fix #2 and 1 more'), 1);
  // A count given for context never wins (round-1 critic, f4): the one tied to "more" does; counts that still differ name none.
  assert.equal(namedRounds('two more rounds; it used 3 rounds'), 2);
  assert.equal(namedRounds('2 rounds or 3 rounds'), null, 'different counts: one round');
  assert.equal(namedRounds('one more, then two more'), null);
  for (const t of ['approved once PR 1234 lands', 'approved after the demo', 'approved when CI is green', 'approved until Friday']) assert.equal(noteApproves(t), false, t);
  assert.equal(namedRounds('Approved'), null);
});

test('approval: from the dashboard or the web counts; a lead\'s entry without the person\'s words does not', () => {
  const q = (answer, approves = 'Yes') => ({ id: 'q1', approves, answer });
  const a = (via, extra = {}) => ({ choices: ['Yes'], other: null, by: 'person', via, at: T, ...extra });
  assert.equal(answerRefusal(q(a('dashboard'))), null);
  assert.equal(answerRefusal(q(a('web'))), null);
  assert.equal(answerRefusal(q(a('cli', { confirm: 'yes please' }))), null);
  assert.match(answerRefusal(q(a('cli'))), /not given by the person/);
  assert.match(answerRefusal(q({ choices: ['Yes'], other: null, by: 'person', at: T })), /not given by the person/, 'older entries without via do not count');
  assert.match(answerRefusal(q(a('web', { by: 'lead' }))), /not given by the person/);
  assert.match(answerRefusal(q(a('web', { choices: ['No'] }))), /answered "No"/);
  assert.equal(noteRefusal({ text: 'Approved, go ahead with one more round', via: 'web' }), null);
  assert.equal(noteApproves('approve one more round for m1'), true);
  for (const t of ['no', 'not approved', 'approved?', "can't approve", 'approve if green', 'maybe approved', 'yes', 'go']) assert.equal(noteApproves(t), false, t);
});

test('a chain may change the unit id: both ids show, stats count it once, a parent is continued once', () => {
  run('init', 'w1', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'w1', 'u1213', '--bar', 'b'); run('freeze', 'w1');
  run('start', 'w1', 'u1213'); run('built', 'w1', 'u1213'); run('verdict', 'w1', 'u1213', 'fail', '--severity', 'high', '--score', '5', '--gap', 'x'); run('next', 'w1');
  run('close', 'w1', '--outcome', 'stopped', '--reason', 'finish in a follow-on run');
  run('init', 'fin', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  assert.equal(run('add', 'fin', 'u1213b', '--bar', 'b', '--continues', 'w1:u1213').code, 0);
  assert.deepEqual(state('fin').continues, [{ run: 'w1', unit: 'u1213', as: 'u1213b' }]);
  assert.deepEqual(state('w1').units[0].continuedIn.map((c) => [c.run, c.unit]), [['fin', 'u1213b']]);
  assert.match(run('add', 'fin', 'u1213c', '--bar', 'b', '--continues', 'w1:u1213').err, /already continued in fin:u1213b/, 'no fork inside one run either');
  run('freeze', 'fin');
  assert.match(run('show', 'fin').out, /↔ continues w1:u1213 \(1 try, stopped\)/);
  assert.match(run('show', 'w1').out, /↔ continued in fin:u1213b \(0 tries, open\)/);
  run('start', 'fin', 'u1213b'); run('built', 'fin', 'u1213b'); run('verdict', 'fin', 'u1213b', 'pass', '--evidence', 'green', '--score', '9'); run('integrate', 'fin', 'pass', '--evidence', 'ok');
  run('close', 'fin', '--outcome', 'done');
  const st = run('stats').out;
  const both = [state('w1'), state('fin')];
  assert.deepEqual(chainUnits(both).map((u) => [u.id, u.status, u.rounds, u.links.map((l) => `${l.run}:${l.unit}`).join(' → ')]), [['u1213b', 'pass', 2, 'w1:u1213 → fin:u1213b']]);
  assert.ok(st.units >= 1 && chainUnits(both).length === 1);
});

test('a chain left open in a closed run is unfinished: neither passed nor stopped', () => {
  const runs = real().slice(0, 3); // stops at 1.0c, where c14 sits open below
  runs[2].units[0] = { ...runs[2].units[0], status: 'open', stopReason: null };
  const c14 = chainUnits(runs).find((u) => u.id === 'c14');
  assert.deepEqual([c14.status, c14.outcome, c14.rounds], ['open', 'unfinished', 3]);
  const s = stats(runs);
  assert.deepEqual([s.units, s.stoppedShare, s.unfinished, s.unfinishedShare], [3, 0, 1, 0.33]);
  assert.equal(chainOf(runs, 'coordinator-1.0b', 'c14').final.outcome, 'unfinished');
  const m = selfModel({ runs, nowMs: Date.parse(T) });
  assert.equal(m.chains.find((c) => c.unit === 'c14').status, 'unfinished');
  assert.match(selfText(m), /unfinished 1 \(left open when the run closed\)/);
});

test('a unit with extra rounds stops at the raised cap', () => {
  const rising = [5, 6, 7].map((score, i) => ({ n: i + 1, verdict: 'fail', score, gap: `gap ${['alpha', 'beta', 'gamma'][i]}`, at: T }));
  const u = { id: 'm1', status: 'open', rounds: rising, extraRounds: 1, strategyChanges: 0, strategyAt: -1 };
  const x = mk('x', [u]);
  assert.equal(decideUnit(u, x, Date.parse(T)).action, 'build');
  assert.equal(decideUnit({ ...u, extraRounds: 0 }, x, Date.parse(T)).reason, 'budget: rounds');
  assert.equal(view(x, decide(x, Date.parse(T)), Date.parse(T)).units[0].maxRounds, 4);
});
