// Script friction from a real run (#66): beat on an open unit, early reviews of a stacked unit,
// the evidence cap per round, the push visibility hint, and a unit merged on the person's
// decision with no final verdict (`ship`), after which `close` works.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decisionRefusal } from '../lib/approval.mjs';
import { addEvidence, LIMITS } from '../lib/evidence.mjs';
import { decideUnit, earlyReviews } from '../lib/rules.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-friction-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: dir, env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const state = (run) => JSON.parse(readFileSync(join(dir, 'runs', run, 'state.json'), 'utf8'));
const unit = (run, id) => state(run).units.find((u) => u.id === id);
const nextOf = (run, id) => ok('next', run).units.find((u) => u.id === id);
// Two units, b stacked on a.
function setup(run) {
  ok('init', run, '--goal', 'g', '--bar', 'b', '--fence', 'f');
  ok('add', run, 'a', '--bar', 'a works'); ok('add', run, 'b', '--bar', 'b works', '--after', 'a');
  ok('freeze', run);
}

test('beat on an open unit (work started early) is logged as early and leaves the unit open (#66 item 2)', () => {
  setup('beat');
  ok('start', 'beat', 'a');
  ok('beat', 'beat', 'b', '--text', 'builder started b early, on the person\'s ask');
  const b = unit('beat', 'b');
  assert.equal(b.status, 'open');
  assert.equal(b.heartbeatAt, null, 'no rule reads an early beat');
  assert.equal(b.log.at(-1).kind, 'beat');
  assert.match(b.log.at(-1).text, /^early \(not started\): builder started b early/);
  assert.equal(nextOf('beat', 'b').action, 'wait');
  // A unit the rules stopped still refuses it.
  ok('ship', 'beat', 'a', '--merge', 'https://github.com/o/r/pull/9', '--reason', 'r', '--confirm', 'Yes, merge it');
  assert.match(cli('beat', 'beat', 'a').err, /unit a is pass/);
});

test('verdict --early records a review of a stacked unit apart: counted by next and shown, never a round (#66 item 3)', () => {
  setup('early');
  ok('start', 'early', 'a');
  assert.match(cli('verdict', 'early', 'b', 'pass', '--score', '9', '--evidence', 'e').err, /record built first \(a review of work started early: verdict --early\)/);
  ok('verdict', 'early', 'b', 'pass', '--early', '--specialist', 'security', '--score', '9.3', '--evidence', 'no auth gaps', '--head', 'abc1234');
  ok('verdict', 'early', 'b', 'fail', '--early', '--score', '7', '--evidence', 'B2 fails', '--gap', 'B2: the list misses one state', '--severity', 'medium');
  const b = unit('early', 'b');
  assert.equal(b.status, 'open'); assert.equal(b.rounds.length, 0, 'an early review is not a round');
  assert.deepEqual(b.early.map((r) => [r.n, r.before, r.by, r.verdict, r.score]), [[1, 1, 'security', 'pass', 9.3], [2, 1, 'critic', 'fail', 7]]);
  assert.equal(b.early[0].head, 'abc1234');
  const n = nextOf('early', 'b');
  assert.equal(n.action, 'wait');
  assert.deepEqual([n.early.count, n.early.text], [2, '2 early reviews, not rounds (security pass 9.3; critic fail 7)']);
  assert.match(cli('show', 'early').out, /◦ 2 early reviews, not rounds/);
  const page = readFileSync(join(dir, 'runs', 'early', 'units', 'b.html'), 'utf8');
  assert.match(page, /Early reviews \(not rounds\)/);
  assert.match(page, /B2: the list misses one state/);
  // It never bypasses the formal rules.
  assert.match(cli('verdict', 'early', 'b', 'pass', '--early', '--score', '9', '--evidence', 'e', '--fold', 'nit: x').err, /--fold does not go with --early/);
  assert.match(cli('verdict', 'early', 'b', 'pass', '--early', '--evidence', 'e').err, /--score is required on an early review/);
  assert.match(cli('verdict', 'early', 'b', 'fail', '--early', '--score', '5', '--evidence', 'e', '--gap', 'g', '--severity', 'low').err, /does not fail a round/);
  ok('built', 'early', 'a');
  assert.match(cli('verdict', 'early', 'a', 'pass', '--early', '--score', '9', '--evidence', 'e').err, /a is judging; record the verdict without --early/);
  ok('verdict', 'early', 'a', 'pass', '--score', '9', '--evidence', 'e');
  assert.equal(nextOf('early', 'b').action, 'build', 'the early pass did not pass b');
  ok('start', 'early', 'b'); ok('built', 'early', 'b');
  ok('verdict', 'early', 'b', 'fail', '--score', '8', '--evidence', 'e', '--gap', 'one more gap', '--severity', 'medium');
  assert.equal(nextOf('early', 'b').early, undefined, 'early reviews count only until the round they came before');
  assert.deepEqual(earlyReviews(unit('early', 'b')), []);
  // Pure: the rules read nothing of them.
  const u = unit('early', 'b'); const s = state('early');
  assert.deepEqual(decideUnit({ ...u, early: undefined }, s, Date.now()), decideUnit(u, s, Date.now()));
});

test('evidence is capped per round, not per unit; older pieces with no round count toward none (#66 item 4)', () => {
  const s = { units: [], goalEvidence: [], integration: { rounds: [] } };
  const u = { id: 'u', rounds: [], evidence: [] };
  for (let i = 0; i < LIMITS.perRound; i++) addEvidence(s, u, { kind: 'log', text: `piece ${i}` }, dir);
  assert.throws(() => addEvidence(s, u, { kind: 'log', text: 'one more' }, dir), /60 pieces of evidence at most in one round \(round 1 of u\)/);
  u.rounds.push({ n: 1, verdict: 'fail' });
  assert.equal(addEvidence(s, u, { kind: 'log', text: 'round 2' }, dir), 'E61');
  assert.deepEqual([u.evidence[0].round, u.evidence.at(-1).round], [1, 2]);
  // An older run's 60 pieces (no round recorded) leave room for this round.
  const old = { id: 'o', rounds: [{ n: 1 }], evidence: Array.from({ length: 60 }, (_, i) => ({ id: `E${i + 1}`, kind: 'log', text: 't' })) };
  assert.equal(addEvidence(s, old, { kind: 'log', text: 'new' }, dir), 'E61');
  // The ids stop at E999.
  const full = { id: 'f', rounds: [], evidence: Array.from({ length: LIMITS.total }, (_, i) => ({ id: `E${i + 1}`, round: 0 })) };
  assert.throws(() => addEvidence(s, full, { kind: 'log', text: 'x' }, dir), /999 pieces of evidence at most for f/);
  // The goal's pieces belong to its integration rounds.
  addEvidence(s, null, { kind: 'log', text: 'goal' }, dir);
  assert.equal(s.goalEvidence[0].round, 1);
});

test('init names the visibility key push needs while it is unset (#66 item 5)', () => {
  const out = ok('init', 'vis', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  assert.match(out.setup, /Set "visibility" in .*coordinator\.json: \{"visibility": "private"\}/);
  writeFileSync(join(dir, 'coordinator.json'), JSON.stringify({ visibility: 'private' }));
  try { assert.equal(ok('init', 'vis2', '--goal', 'g', '--bar', 'b', '--fence', 'f').setup, undefined); } finally { rmSync(join(dir, 'coordinator.json')); }
});

test('ship: a unit merged on the person\'s decision with no final verdict ends shipped, and close works (#66 item 6)', () => {
  setup('ship');
  ok('start', 'ship', 'a'); ok('built', 'ship', 'a'); ok('verdict', 'ship', 'a', 'pass', '--score', '9', '--evidence', 'e');
  ok('start', 'ship', 'b'); ok('built', 'ship', 'b');
  ok('verdict', 'ship', 'b', 'fail', '--score', '6', '--evidence', 'e', '--gap', 'empty state missing', '--severity', 'medium');
  ok('start', 'ship', 'b'); ok('built', 'ship', 'b');
  // b is being judged; the person says merge it. Before: close refused, with nowhere to go.
  assert.match(cli('close', 'ship', '--outcome', 'partial', '--reason', 'r').err, /b still in progress \(merged on the person's decision with no final verdict: run\.mjs ship ship <unit>/);
  assert.match(cli('ship', 'ship', 'b', '--reason', 'r', '--confirm', 'Yes').err, /--merge URL is required/);
  assert.match(cli('ship', 'ship', 'b', '--merge', 'https://github.com/o/r/pull/7', '--reason', 'r').err, /no decision from the person on b/);
  assert.match(cli('ship', 'ship', 'b', '--merge', 'https://github.com/o/r/pull/7', '--reason', 'r', '--confirm', 'no, do not merge yet').err, /do not clearly say it/);
  ok('note', 'ship', '--kind', 'person', '--unit', 'b', '--text', 'merge it');
  assert.match(cli('ship', 'ship', 'b', '--merge', 'https://github.com/o/r/pull/7', '--reason', 'r').err, /not added by the person/, 'a lead\'s own note never counts');
  ok('ship', 'ship', 'b', '--merge', 'https://github.com/o/r/pull/7', '--reason', 'merged on the finish-line call', '--confirm', 'Yes, merge; rest as issues');
  const b = unit('ship', 'b');
  assert.equal(b.status, 'pass');
  assert.deepEqual([b.shipped.verdict, b.shipped.was, b.shipped.round, b.shipped.merge], ['none', 'judging', 1, 'https://github.com/o/r/pull/7']);
  assert.equal(b.judgingAt, undefined);
  assert.equal(b.links.at(-1).kind, 'merge');
  const notes = state('ship').notes;
  assert.match(notes.find((n) => n.kind === 'decision' && n.unit === 'b').text, /b: shipped without a final verdict \(it was judging, last round 1 fail\), merged as https:\/\/github\.com\/o\/r\/pull\/7 on the person's decision \(their words via cli: "Yes, merge; rest as issues"\)/);
  const follow = notes.filter((n) => n.kind === 'follow-up' && n.unit === 'b');
  assert.deepEqual(follow.map((n) => n.noVerdict), [true, true]);
  assert.match(follow[0].text, /no critic judged what merged/);
  assert.match(follow[1].text, /b \(shipped, medium\): empty state missing/);
  assert.match(cli('ship', 'ship', 'b', '--merge', 'https://github.com/o/r/pull/7', '--reason', 'r', '--confirm', 'yes').err, /b has shipped already/);
  // Delivered, never a clean pass; the missing verdict is a gap.
  assert.match(cli('show', 'ship').out, /b\s+shipped .*\n.*shipped without a final verdict on the person's decision after 1 judged try/i);
  const page = readFileSync(join(dir, 'runs', 'ship', 'units', 'b.html'), 'utf8');
  assert.match(page, /Shipped without a final verdict/);
  assert.match(cli('gaps').out, /b \(shipped without a final verdict\): no critic judged/);
  assert.equal(ok('next', 'ship').decision, 'integrate');
  ok('integrate', 'ship', 'pass', '--evidence', 'both merged, suite green');
  ok('close', 'ship', '--outcome', 'done');
  assert.match(cli('status-line', 'ship').out, /concluded: done\. Delivered: a; b\. Follow-ups: 2 in Gaps/);
  assert.equal(ok('stats').shipped >= 1, true, 'stats count it apart from clean passes');
});

test('ship takes the person\'s answer to a question on the unit, used once (#66 item 6)', () => {
  setup('shipq');
  ok('start', 'shipq', 'a');
  const q = ok('ask', 'shipq', '--unit', 'a', '--question', 'Merge a now?', '--header', 'a', '--option', 'Yes|merge it', '--option', 'No|wait', '--approves', 'Yes').asked;
  ok('answer', 'shipq', q, '--choice', 'No', '--by', 'person', '--confirm', 'No');
  assert.match(cli('ship', 'shipq', 'a', '--merge', 'https://github.com/o/r/pull/3', '--reason', 'r', '--answer', q).err, /answered "No", not "Yes"/);
  ok('answer', 'shipq', q, '--choice', 'Yes', '--by', 'person', '--confirm', 'Yes, ship it');
  ok('ship', 'shipq', 'a', '--merge', 'https://github.com/o/r/pull/3', '--reason', 'r', '--answer', q);
  assert.deepEqual([unit('shipq', 'a').shipped.answer, unit('shipq', 'a').shipped.was], [q, 'building']);
  assert.equal(state('shipq').notes.find((n) => n.kind === 'decision' && n.unit === 'a').answers, q);
  assert.equal(nextOf('shipq', 'b').action, 'build', 'the unit stacked on it may start');
});

test('decisionRefusal: the person\'s words, clear, with no "approve" needed', () => {
  assert.equal(decisionRefusal({ text: 'Yes, merge; rest as issues', via: 'cli', confirm: true }), null);
  assert.equal(decisionRefusal({ text: 'merge it', via: 'dashboard' }), null);
  assert.match(decisionRefusal({ text: 'merge it', via: 'cli' }), /not added by the person/);
  assert.match(decisionRefusal({ text: 'merge it if CI is green', via: 'web' }), /do not clearly say it/);
  assert.match(decisionRefusal({ text: 'merge?', via: 'web' }), /do not clearly say it/);
});

// Old runs: a unit with none of the new fields decides as before.
test('a unit from before #66 (no early, no shipped, evidence with no round) loads and decides unchanged', () => {
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  const s = { budget: { maxRounds: 4, maxMinutes: 240, staleMinutes: 45 }, createdAt: new Date().toISOString(), frozen: true, units: [] };
  const u = { id: 'x', status: 'open', rounds: [], evidence: [{ id: 'E1', kind: 'log', text: 't' }] };
  s.units.push(u);
  assert.deepEqual(decideUnit(u, s, Date.now()), { action: 'build' });
  assert.deepEqual(earlyReviews(u), []);
});
