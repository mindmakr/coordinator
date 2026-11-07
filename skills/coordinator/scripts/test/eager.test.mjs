// Runs that end eagerly (#51): severity gates, fold-ins and their targeted check, the
// finish-line question, a verdict from a critic that started inside the time budget (#45),
// the open-ended bar warning and the cost recorder. Old runs keep loading.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { costEntry, costLine, runCost } from '../lib/cost.mjs';
import { openWords } from '../lib/openbar.mjs';
import { decideUnit } from '../lib/rules.mjs';
import { buildBrief } from '../lib/briefs.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-eager-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const state = (run) => JSON.parse(readFileSync(join(dir, 'runs', run, 'state.json'), 'utf8'));
const unit = (run, id) => state(run).units.find((u) => u.id === id);
const nextOf = (run, id) => ok('next', run).units.find((u) => u.id === id);
function setup(run, units = ['a']) {
  ok('init', run, '--goal', 'g', '--bar', 'the tests in test/x pass', '--fence', 'f');
  for (const u of units) ok('add', run, u, '--bar', 'b');
  ok('freeze', run);
}
const build = (run, u, ...cost) => { ok('start', run, u); ok('built', run, u, ...cost); };

test('a fail needs a high or medium severity; a low or nit is refused with "pass, and record them as fold-ins"', () => {
  setup('sev'); build('sev', 'a');
  assert.match(cli('verdict', 'sev', 'a', 'fail', '--score', '5', '--gap', 'g', '--evidence', 'e').err, /--severity high\|medium is required on a fail/);
  for (const low of ['low', 'nit']) assert.match(cli('verdict', 'sev', 'a', 'fail', '--score', '5', '--gap', 'g', '--evidence', 'e', '--severity', low).err, /pass, and record them as fold-ins/);
  assert.match(cli('verdict', 'sev', 'a', 'fail', '--score', '5', '--gap', 'g', '--evidence', 'e', '--severity', 'huge').err, /--severity must be one of: high, medium, low, nit/);
  assert.match(cli('verdict', 'sev', 'a', 'pass', '--score', '9', '--evidence', 'e', '--severity', 'low').err, /--severity goes with a fail/);
  assert.match(cli('verdict', 'sev', 'a', 'fail', '--score', '5', '--gap', 'g', '--evidence', 'e', '--severity', 'high', '--fold', 'x').err, /--fold goes with a pass/);
  ok('verdict', 'sev', 'a', 'fail', '--score', '5', '--gap', 'wrong total', '--evidence', 'e', '--severity', 'High', '--full-suite', 'yes');
  const r = unit('sev', 'a').rounds[0];
  assert.equal(r.severity, 'high'); assert.equal(r.fullSuite, true);
});

test('a pass with fold-ins waits for the targeted fold-in check, then next says merge', () => {
  setup('fold'); build('fold', 'a');
  ok('verdict', 'fold', 'a', 'pass', '--score', '9', '--evidence', 'suite green', '--fold', 'rename x to y (low)', '--fold', 'typo in README (nit)', '--full-suite');
  assert.deepEqual(unit('fold', 'a').rounds[0].folds, ['rename x to y (low)', 'typo in README (nit)']);
  const d = nextOf('fold', 'a');
  assert.equal(d.action, 'fold-in'); assert.match(d.step, /run\.mjs foldin fold a --head <sha>/);
  assert.equal(ok('next', 'fold').decision, 'continue', 'no integration before the folds are checked');
  assert.match(cli('foldin', 'fold', 'a', '--head', 'not-a-sha', '--evidence', 'e').err, /--head takes the commit/);
  assert.match(cli('foldin', 'fold', 'a', '--head', 'abc1234').err, /missing --evidence/);
  ok('foldin', 'fold', 'a', '--head', 'ABC1234def', '--evidence', 'diff is the two folds; test/x.test.mjs green', '--minutes', '4');
  assert.equal(unit('fold', 'a').rounds[0].foldin.head, 'abc1234def');
  assert.deepEqual(nextOf('fold', 'a'), { id: 'a', action: 'done', step: 'merge' });
  assert.equal(ok('next', 'fold').decision, 'integrate');
  assert.match(cli('foldin', 'fold', 'a', '--head', 'abc1234', '--evidence', 'again').err, /foldin refused: next says "done"/);
  // A pass with no fold-ins merges straight away, as before; foldin is refused there.
  setup('nofold'); build('nofold', 'a'); ok('verdict', 'nofold', 'a', 'pass', '--score', '9', '--evidence', 'e');
  assert.deepEqual(nextOf('nofold', 'a'), { id: 'a', action: 'done' });
  assert.match(cli('foldin', 'nofold', 'a', '--head', 'abc1234', '--evidence', 'e').err, /foldin refused/);
});

test('a specialist fail needs a severity too, and its fold-ins ride on the pass', () => {
  ok('init', 'spf', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'spf', 'a', '--bar', 'b', '--specialist', 'security'); ok('freeze', 'spf');
  build('spf', 'a');
  assert.match(cli('verdict', 'spf', 'a', 'fail', '--score', '4', '--gap', 'g', '--evidence', 'e', '--specialist', 'security', '--severity', 'nit').err, /record them as fold-ins/);
  ok('verdict', 'spf', 'a', 'pass', '--evidence', 'e', '--specialist', 'security', '--fold', 'log line too chatty');
  ok('verdict', 'spf', 'a', 'pass', '--score', '9', '--evidence', 'e');
  assert.deepEqual(unit('spf', 'a').rounds[0].folds, ['log line too chatty (security)']);
});

test('link --merge --same-tree records that the post-merge re-check was skipped', () => {
  setup('tree'); build('tree', 'a');
  assert.match(cli('link', 'tree', 'a', '--merge', 'https://github.com/o/r/pull/1', '--same-tree', 'abc1234').err, /--same-tree: a has not passed/);
  ok('verdict', 'tree', 'a', 'pass', '--score', '9', '--evidence', 'e');
  assert.match(cli('link', 'tree', 'a', '--same-tree', 'abc1234').err, /--same-tree goes with --merge/);
  ok('link', 'tree', 'a', '--merge', 'https://github.com/o/r/pull/1', '--same-tree', 'abc1234');
  const u = unit('tree', 'a');
  assert.equal(u.postMerge.tree, 'abc1234'); assert.match(u.postMerge.check, /^skipped/);
});

test('finish line: the last unit open with only mediums asks the person; their pick decides', () => {
  setup('fin', ['a', 'b']);
  build('fin', 'a'); ok('verdict', 'fin', 'a', 'pass', '--score', '9', '--evidence', 'e');
  build('fin', 'b');
  // A high finding is a normal fail: another round.
  ok('verdict', 'fin', 'b', 'fail', '--score', '6', '--gap', 'leaks a token', '--evidence', 'e', '--severity', 'high');
  assert.equal(nextOf('fin', 'b').action, 'build');
  assert.match(cli('ask', 'fin', '--finish', 'b').err, /ask --finish refused: next says "build"/);
  build('fin', 'b');
  ok('verdict', 'fin', 'b', 'fail', '--score', '8', '--gap', 'two labels unclear', '--evidence', 'e', '--severity', 'medium');
  const d = nextOf('fin', 'b');
  assert.equal(d.action, 'ask-person');
  assert.equal(d.question.header, 'Finish line');
  assert.deepEqual(d.question.options.map((o) => o.split('|')[0]), ['Ship with follow-ups', 'One more round', 'Stop']);
  assert.match(d.step, /run\.mjs ask fin --finish b/);
  assert.match(cli('start', 'fin', 'b').err, /start refused: next says "ask-person"/);
  assert.match(cli('ask', 'fin', '--finish', 'b', '--header', 'x').err, /--header does not go with --finish/);
  const q = ok('ask', 'fin', '--finish', 'b').asked;
  assert.match(cli('ask', 'fin', '--finish', 'b').err, /already asked as q1/);
  assert.equal(nextOf('fin', 'b').asked, q);
  // The lead's own pick does not count; the person's does.
  ok('answer', 'fin', q, '--choice', 'Ship with follow-ups', '--by', 'lead');
  assert.match(nextOf('fin', 'b').reason, /not one option picked by the person/);
  ok('answer', 'fin', q, '--choice', 'Ship with follow-ups', '--by', 'person', '--confirm', 'ship it, file the labels');
  const shipped = nextOf('fin', 'b');
  assert.equal(shipped.action, 'done'); assert.match(shipped.reason, /shipped with follow-ups \(q1\)/);
  const s = state('fin');
  assert.equal(s.units[1].status, 'pass'); assert.equal(s.units[1].shipped.answer, 'q1');
  assert.ok(s.notes.some((n) => n.kind === 'follow-up' && /two labels unclear/.test(n.text)));
  assert.ok(s.notes.some((n) => n.kind === 'decision' && n.answers === 'q1'));
  assert.equal(ok('next', 'fin').decision, 'integrate');
});

test('finish line: "one more round" allows one build past the cap; "Stop" stops it', () => {
  ok('init', 'fin2', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1'); ok('add', 'fin2', 'a', '--bar', 'b'); ok('freeze', 'fin2');
  build('fin2', 'a'); ok('verdict', 'fin2', 'a', 'fail', '--score', '8', '--gap', 'medium gap', '--evidence', 'e', '--severity', 'medium');
  const q = ok('ask', 'fin2', '--finish', 'a').asked;
  ok('answer', 'fin2', q, '--choice', 'One more round', '--by', 'person', '--confirm', 'one more round please');
  assert.equal(nextOf('fin2', 'a').action, 'build', 'the person\'s pick lifts the round cap for one round');
  build('fin2', 'a'); ok('verdict', 'fin2', 'a', 'fail', '--score', '8', '--gap', 'still medium', '--evidence', 'e', '--severity', 'medium');
  const q2 = ok('ask', 'fin2', '--finish', 'a').asked;
  assert.notEqual(q2, q, 'a new verdict asks again');
  ok('answer', 'fin2', q2, '--choice', 'Stop', '--by', 'person', '--confirm', 'stop it');
  assert.equal(nextOf('fin2', 'a').action, 'stop');
  assert.match(unit('fin2', 'a').stopReason, /the person chose stop \(q2\)/);
});

test('a critic that started inside the time budget can still record its verdict (#45)', () => {
  setup('late', ['a', 'b']); build('late', 'a'); build('late', 'b');
  // Move the clock: the run started 5 h ago with a 4 h budget; a was built (judging) 4.5 h in, b 3 h in.
  const file = join(dir, 'runs', 'late', 'state.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const t0 = Date.now() - 5 * 3600_000;
  s.createdAt = new Date(t0).toISOString();
  s.units[0].judgingAt = new Date(t0 + 4.5 * 3600_000).toISOString();
  s.units[1].judgingAt = new Date(t0 + 3 * 3600_000).toISOString();
  assert.equal(decideUnit(s.units[0], s, Date.now()).action, 'stop');
  assert.deepEqual(decideUnit(s.units[1], s, Date.now()), { action: 'judge', reason: 'the critic started inside the time budget' });
  delete s.units[1].judgingAt; // an older run never recorded when judging began: the budget stops it, as before
  assert.equal(decideUnit(s.units[1], s, Date.now()).action, 'stop');
});

test('the open-ended heuristic: open words without a closed list', () => {
  for (const open of ['Catch every leaked secret', 'any message that names the employer is blocked', 'It should never log a token anywhere', 'All error pages are translated'])
    assert.ok(openWords(open).length, open);
  for (const closed of ['These six templates use the new header', 'every key in the committed en.json inventory has an ar entry', 'every route listed in routes.md returns 403',
    'all of: /a, /b, /c return 403', 'It shows totals in SAR with two decimals', 'every page (home, list, detail) renders in Arabic', 'all tests pass'])
    assert.deepEqual(openWords(closed), [], closed);
});

test('init, add and behave warn on an open-ended line; --accept-open silences it and is recorded', () => {
  const w = ok('init', 'open', '--goal', 'g', '--bar', 'catch every leaked secret', '--fence', 'f');
  assert.match(w.warning, /the bar reads open-ended \(every, catch\).*--accept-open/);
  assert.equal(ok('init', 'open2', '--goal', 'g', '--bar', 'catch every leaked secret', '--fence', 'f', '--accept-open').warning, undefined);
  assert.ok(state('open2').notes.some((n) => n.kind === 'bar' && /kept an open-ended line on purpose/.test(n.text)));
  assert.match(ok('add', 'open', 'a', '--bar', 'b', '--behaviour', 'any message that names the employer is masked').warning, /a B1 reads open-ended/);
  assert.equal(ok('add', 'open', 'b', '--bar', 'these three routes return 403').warning, undefined);
  assert.match(ok('behave', 'open', 'b', '--text', 'It should never log a token anywhere').warning, /never … anywhere/);
  ok('behave', 'open', 'b', '--text', 'It should mask every secret', '--accept-open');
  assert.equal(state('open').notes.filter((n) => n.kind === 'bar').length, 1);
});

test('cost: start, built and verdict record what the harness reported; show, stats and the HUD sum it', () => {
  assert.equal(costEntry({}, { step: 'built', role: 'builder', at: 'x' }), null);
  assert.throws(() => costEntry({ 'tokens-in': '1.5' }, { step: 's', role: 'r', at: 'x' }), /whole number/);
  assert.throws(() => costEntry({ cost: '0.42' }, { step: 's', role: 'r', at: 'x' }), /currency code/);
  assert.deepEqual(costEntry({ cost: 'usd 0.42', minutes: '3.5' }, { step: 's', role: 'r', at: 'x' }).cost, { amount: 0.42, currency: 'USD' });
  setup('cost', ['a', 'b']);
  ok('start', 'cost', 'a', '--model', 'sonnet', '--tokens-in', '1000');
  ok('built', 'cost', 'a', '--tokens-in', '12000', '--tokens-out', '3400', '--minutes', '21', '--cost', '0.80 USD');
  ok('verdict', 'cost', 'a', 'pass', '--score', '9', '--evidence', 'e', '--model', 'opus', '--tokens-in', '30000', '--tokens-out', '2000', '--minutes', '14.5', '--cost', '1.20 USD');
  const u = unit('cost', 'a');
  assert.deepEqual(u.costs.map((c) => [c.step, c.role, c.model ?? null]), [['start', 'builder', 'sonnet'], ['built', 'builder', 'sonnet'], ['verdict', 'critic', 'opus']]);
  assert.equal(costLine(runCost(state('cost'))), '43k in / 5.4k out tokens · 35.5 min · 2 USD');
  const show = cli('show', 'cost').out;
  assert.match(show, /cost {5}run: 43k in \/ 5\.4k out tokens · 35\.5 min · 2 USD/);
  assert.match(show, /by unit: a: 43k in .*; b: not recorded/);
  assert.match(show, /by model: opus: 30k in \/ 2k out tokens · 14\.5 min · 1\.2 USD; sonnet: 13k in/);
  const hud = readFileSync(join(dir, 'runs', 'cost', 'hud.html'), 'utf8');
  assert.match(hud, /data-a="budget-cost"/); assert.match(hud, /b: not recorded/);
  build('cost', 'b'); ok('verdict', 'cost', 'b', 'pass', '--score', '9', '--evidence', 'e');
  ok('integrate', 'cost', 'pass', '--evidence', 'e'); ok('close', 'cost', '--outcome', 'done');
  const st = ok('stats');
  assert.equal(st.costByRun.find((r) => r.run === 'cost').line, '43k in / 5.4k out tokens · 35.5 min · 2 USD');
  assert.deepEqual(st.costByUnit.filter((r) => r.run === 'cost').map((r) => r.line.split(' · ')[0]), ['43k in / 5.4k out tokens', 'not recorded']);
  assert.ok(st.costByModel.some((m) => m.model === 'opus' && m.tokensIn === 30000));
});

test('the briefs carry the test-run budget and the severity format', () => {
  setup('brief'); const s = state('brief');
  const b = buildBrief(s, { role: 'builder', unit: 'a' });
  assert.match(b, /Run only the suites your change touches.*then the full suite once before you report/s);
  const c = buildBrief(s, { role: 'critic', unit: 'a' });
  assert.match(c, /Run the full suite once/); assert.match(c, /only when you suspect a flake, and say so/);
  assert.match(c, /FINDINGS: one line each, <high\|medium\|low\|nit> <file:line> <what>/);
  assert.match(c, /FOLDS:/); assert.match(c, /Fail only on a high or medium finding/);
});

test('old runs still load and decide: no severity, folds, costs or judgingAt', () => {
  const fixtures = join(scripts, 'test', 'fixtures', 'old-runs');
  const home = mkdtempSync(join(tmpdir(), 'coordinator-eager-old-'));
  try {
    for (const v of readdirSync(fixtures)) cpSync(join(fixtures, v, 'runs'), join(home, 'runs'), { recursive: true, force: true });
    const old = (...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env: { ...process.env, COORDINATOR_DIR: home }, encoding: 'utf8' });
    for (const run of ['old-open', 'old-closed']) {
      const r = old('show', run);
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /cost {5}run: not recorded/);
    }
    const st = old('stats');
    assert.equal(st.status, 0, st.stderr);
    assert.ok(JSON.parse(st.stdout).costByRun.every((x) => x.line === 'not recorded'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
