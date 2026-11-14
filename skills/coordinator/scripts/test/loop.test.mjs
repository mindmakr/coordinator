// What the reins-flight retro changed in the loop (run coord-retro-fixes, unit u1):
// the clock pauses while the person decides, two failing rounds in the same files ask
// the person whatever the cause tags say, no progress reads the lowest critic of each
// round, and a brief is never cut silently.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allows, decide, decideUnit, findingFile } from '../lib/rules.mjs';
import { pausedMinutes, usedMinutes } from '../lib/clock.mjs';
import { estimate } from '../lib/plain.mjs';
import { eta } from '../lib/progress.mjs';
import { text as textView, view } from '../lib/view.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * MIN).toISOString();
const run = (units, extra = {}) => ({
  id: 'r', goal: 'g', bar: 'b', fence: 'f', tag: 'code', createdAt: at(0), frozen: true, integration: { rounds: [] }, notes: [],
  budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, units, ...extra,
});
const unit = (rounds = [], extra = {}) => ({ id: 'u1', bar: 'b', status: 'open', rounds, strategyChanges: 0, strategyAt: -1, ...extra });
const fail = (n, o = {}) => ({ n, verdict: 'fail', gap: `gap ${n}`, severity: 'high', score: 5, at: at(n * 10), ...o });
const question = (minute, answeredMinute, extra = {}) => ({
  kind: 'question', text: 'Which way?', header: 'Way', options: [{ label: 'A' }, { label: 'B' }], unit: null, at: at(minute), usedAt: null,
  history: answeredMinute === null ? [] : [{ choices: ['A'], other: null, by: 'person', via: 'dashboard', at: at(answeredMinute) }], ...extra,
});

// B3: the clock pauses while a question to the person is open.
test('minutes while a question to the person is open do not count toward the time budget', () => {
  const r = run([unit()], { notes: [question(100, 160), question(140, 200), question(300, null)] });
  assert.equal(pausedMinutes(r, T0 + 90 * MIN), 0, 'nothing asked yet');
  assert.equal(pausedMinutes(r, T0 + 220 * MIN), 100, 'overlapping questions count once: 100 to 200');
  assert.equal(pausedMinutes(r, T0 + 330 * MIN), 130, 'a question still open pauses the clock up to now');
  assert.equal(usedMinutes(r, T0 + 330 * MIN), 200);
  // A question closed by the lead's decision without an answer stops pausing at the decision.
  const decided = run([unit()], { notes: [question(10, null), { kind: 'decision', answers: 'q1', text: 'x', at: at(40) }] });
  assert.equal(pausedMinutes(decided, T0 + 100 * MIN), 30);
});

test('a run near its time budget that waited two hours on an open question starts the approved round after the answer', () => {
  // 230 minutes of a 240-minute budget used, then the person took two hours to answer.
  const u = unit([fail(1, { at: at(200) })]);
  const r = run([u], { notes: [question(230, 350, { unit: 'u1' })] });
  const nowMs = T0 + 355 * MIN;
  const d = decideUnit(u, r, nowMs);
  assert.equal(d.action, 'build', 'the two hours waiting on the person are not spent');
  assert.ok(allows('start', d), 'start is allowed');
  assert.equal(decide(r, nowMs).decision, 'continue');
  // Without the question the same clock is spent.
  assert.deepEqual(decideUnit(u, run([u]), nowMs), { action: 'stop', reason: 'budget: time' });
  // show's time line and the ETA count the same minutes.
  const plan = decide(r, nowMs);
  const v = view(r, plan, nowMs);
  const time = v.budget.find((b) => b.name === 'time');
  assert.equal(time.used, 235);
  assert.match(textView(v), /time 235\/240 min \(120 min paused while the person decided\)/);
  assert.equal(Math.round(estimate(r, plan, nowMs).budgetLeft), 5);
  assert.notEqual(eta(r, plan, nowMs).text, 'the time budget is spent');
});

// B5: no progress reads the lowest score across the general critic and every specialist.
test('no progress uses the lowest critic: one critic rising while a specialist stays flat is no progress', () => {
  const sp = (score) => ({ security: { verdict: 'fail', severity: 'high', gap: 'token in log', score } });
  const rounds = [
    fail(1, { score: 5, cause: 'one', specialists: sp(4) }),
    fail(2, { score: 6, cause: 'two', specialists: sp(4) }),
    fail(3, { score: 7, cause: 'three', specialists: sp(4) }),
  ];
  const d = decideUnit(unit(rounds), run([]), T0);
  assert.equal(d.action, 'stop');
  assert.match(d.reason, /^no progress/);
  // Both rising is progress.
  const rising = rounds.map((r, i) => ({ ...r, specialists: sp(4 + i) }));
  assert.equal(decideUnit(unit(rising), run([]), T0).action, 'build');
});

// B4: two failing rounds with high or medium findings in a common file ask the person.
test('a finding names its file: "src/a.ts:12", a backslash path, a range, or none', () => {
  assert.equal(findingFile('src/a.ts:12 wrong total'), 'src/a.ts');
  assert.equal(findingFile('`src\\lib\\b.mjs:40-52` drops a row'), 'src/lib/b.mjs');
  assert.equal(findingFile('./docs/x.md#L3 typo'), 'docs/x.md');
  assert.equal(findingFile('two labels unclear'), null);
});

test('two failing rounds in the same file under different cause tags ask the person, with the four options', () => {
  const rounds = [
    fail(1, { cause: 'dedupe in memory', findings: [{ severity: 'high', text: 'src/alerts.ts:40 two alerts while the store is down' }] }),
    fail(2, { cause: 'lease never expires', score: 6, severity: 'medium', findings: [{ severity: 'medium', text: 'src/alerts.ts:88 no alert after a crash' }, { severity: 'low', text: 'src/other.ts:1 nit' }] }),
  ];
  const r = run([unit(rounds)]);
  const d = decideUnit(r.units[0], r, T0 + 30 * MIN);
  assert.equal(d.action, 'ask-person');
  assert.equal(d.reason, 'same-files: src/alerts.ts');
  assert.deepEqual(d.question.options.map((o) => o.split('|')[0]), ['Change the bar', 'Simplify the design', 'Accept as is', 'One more round']);
  assert.ok(d.question.header.length <= 12);
  // A low in a common file, or different files, does not ask.
  const lowOnly = [rounds[0], fail(2, { cause: 'x', findings: [{ severity: 'low', text: 'src/alerts.ts:9 nit' }, { severity: 'high', text: 'src/b.ts:1 y' }] })];
  assert.equal(decideUnit(unit(lowOnly), run([]), T0).action, 'build');
  // A specialist's finding counts too.
  const spec = [rounds[0], fail(2, { cause: 'x', specialists: { security: { verdict: 'fail', severity: 'high', gap: 'g', findings: [{ severity: 'high', text: 'src/alerts.ts:3 leaks' }] } } })];
  assert.equal(decideUnit(unit(spec), run([]), T0).reason, 'same-files: src/alerts.ts');
});

// The CLI: verdict, next, ask --finish, answer, next goes on.
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-loop-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const nextOf = (r, id) => ok('next', r).units.find((u) => u.id === id);
const state = (r) => JSON.parse(readFileSync(join(dir, 'runs', r, 'state.json'), 'utf8'));
const build = (r, u) => { ok('start', r, u); ok('built', r, u); };

test('same files through the CLI: next asks, the person picks, and the run goes on', () => {
  ok('init', 'sf', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'sf', 'a', '--bar', 'one alert per outage'); ok('freeze', 'sf');
  build('sf', 'a');
  ok('verdict', 'sf', 'a', 'fail', '--score', '5', '--gap', 'two alerts', '--cause', 'dedupe in memory', '--evidence', 'e', '--severity', 'high', '--finding', 'high src/alerts.ts:40 two alerts while the store is down');
  assert.equal(nextOf('sf', 'a').action, 'build', 'one failing round does not ask');
  build('sf', 'a');
  ok('verdict', 'sf', 'a', 'fail', '--score', '6', '--gap', 'no alert after crash', '--cause', 'lease never expires', '--evidence', 'e', '--severity', 'medium', '--finding', 'medium src/alerts.ts:88 no alert after a crash');
  const d = nextOf('sf', 'a');
  assert.deepEqual([d.action, d.reason], ['ask-person', 'same-files: src/alerts.ts']);
  assert.match(d.step, /run\.mjs ask sf --finish a/);
  assert.match(cli('start', 'sf', 'a').err, /start refused/);
  const q = ok('ask', 'sf', '--finish', 'a').asked;
  const asked = state('sf').notes.filter((n) => n.kind === 'question').at(-1);
  assert.equal(asked.header, 'Same files');
  assert.deepEqual(asked.sameFiles, ['src/alerts.ts']);
  assert.match(nextOf('sf', 'a').reason, /^same-files: src\/alerts\.ts; waiting for the person's answer to q1/);
  ok('answer', 'sf', q, '--choice', 'Simplify the design', '--by', 'person', '--confirm', 'simplify it, one alert per copy is fine');
  assert.equal(nextOf('sf', 'a').action, 'build', 'the answer lets the run go on');
  const decision = state('sf').notes.find((n) => n.kind === 'decision' && n.answers === q);
  assert.match(decision.text, /a: simplify the design, then one more round, the person's choice at the same-files question/);
  // The next fail in the same file asks again; "Accept as is" ships with follow-ups.
  build('sf', 'a');
  ok('verdict', 'sf', 'a', 'fail', '--score', '7', '--gap', 'g3', '--cause', 'third tag', '--evidence', 'e', '--severity', 'medium', '--finding', 'medium src/alerts.ts:12 still racy');
  const q2 = ok('ask', 'sf', '--finish', 'a').asked;
  ok('answer', 'sf', q2, '--choice', 'Accept as is', '--by', 'person', '--confirm', 'ship it with follow-ups');
  const shipped = nextOf('sf', 'a');
  assert.equal(shipped.action, 'done');
  assert.equal(state('sf').units[0].shipped.answer, q2);
});

// B1: --where is never cut silently; --findings-file names the file to read in full.
test('brief refuses a --where over the limit, naming --findings-file, and names a findings file to read in full', () => {
  ok('init', 'bf', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'bf', 'a', '--bar', 'b');
  const long = `worktree D:/x. ${'finding: something to fix. '.repeat(30)}`;
  const r = cli('brief', 'bf', 'a', '--role', 'builder', '--where', long);
  assert.equal(r.code, 1);
  assert.match(r.err, /--where is \d+ characters, over the 500 limit.*--findings-file/);
  assert.equal(cli('brief', 'bf', 'a', '--role', 'builder', '--where', 'x'.repeat(500)).code, 0, '500 characters still fit');
  const file = join(dir, 'findings.md');
  writeFileSync(file, '- high src/a.ts:1 x\n');
  const b = cli('brief', 'bf', 'a', '--role', 'builder', '--where', 'worktree D:/x', '--findings-file', file).out;
  const shown = file.replace(/\\/g, '/');
  assert.ok(b.includes(`Read ${shown} in full first: it lists every finding to fix.`), b);
  const c = cli('brief', 'bf', 'a', '--role', 'critic', '--where', 'worktree D:/x', '--findings-file', file).out;
  assert.ok(c.includes(`Read ${shown} in full first: it lists every finding to check.`), c);
  assert.match(cli('brief', 'bf', 'a', '--role', 'builder', '--findings-file', join(dir, 'missing.md')).err, /--findings-file: no file/);
});
