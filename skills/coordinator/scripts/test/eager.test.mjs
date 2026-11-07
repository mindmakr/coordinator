// Runs that end eagerly (#51): severity gates, fold-ins and their targeted check, the
// finish-line question, a verdict from a critic that started inside the time budget (#45),
// the open-ended bar warning and the cost recorder. Old runs keep loading.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { costEntry, costLine, runCost } from '../lib/cost.mjs';
import { openWords } from '../lib/openbar.mjs';
import { decideUnit, openFindings } from '../lib/rules.mjs';
import { checkFold, parseFinding } from '../lib/findings.mjs';
import { buildBrief } from '../lib/briefs.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-eager-'));
after(() => rmSync(dir, { recursive: true, force: true }));
// A small git repo the fold-in checks read (run.mjs and detect.mjs run with it as their folder).
const repo = mkdtempSync(join(tmpdir(), 'coordinator-eager-repo-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
function commitFiles(files, msg) {
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), body); }
  git('add', '-A'); git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
}
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: repo, env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const detect = (...a) => spawnSync(process.execPath, [join(scripts, 'detect.mjs'), ...a], { cwd: repo, env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
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
  const base = commitFiles({ 'src/a.js': 'export const a = 1;\n' }, 'base');
  const reviewed = commitFiles({ 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': 'ok\n' }, 'the build');
  ok('init', 'fold', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--paths', 'src,test', '--fold-max-files', '3', '--fold-max-lines', '40');
  ok('add', 'fold', 'a', '--bar', 'b'); ok('freeze', 'fold'); build('fold', 'a');
  assert.equal(detect('--run', 'fold', '--unit', 'a', '--base', base, '--head', reviewed).status, 0);
  ok('verdict', 'fold', 'a', 'pass', '--score', '9', '--evidence', 'suite green', '--fold', 'rename x to y', '--fold', 'nit: typo in README', '--full-suite');
  const r = unit('fold', 'a').rounds[0];
  assert.deepEqual(r.folds, ['rename x to y', 'nit: typo in README']); assert.equal(r.reviewedHead, reviewed);
  const d = nextOf('fold', 'a');
  assert.equal(d.action, 'fold-in'); assert.match(d.step, /run\.mjs foldin fold a --head <sha>/);
  assert.equal(ok('next', 'fold').decision, 'continue', 'no integration before the folds are checked');
  assert.match(cli('foldin', 'fold', 'a', '--head', 'abc1234').err, /missing --evidence/);

  // A head that does not build on the reviewed one is refused.
  git('checkout', '-q', '-b', 'other', base);
  const stray = commitFiles({ 'src/a.js': 'export const a = 3;\n' }, 'unrelated');
  assert.match(cli('foldin', 'fold', 'a', '--head', stray, '--evidence', 'e').err, /does not build on the reviewed head/);
  git('checkout', '-q', '-'); // back to the unit's branch

  // Too big: more files than the cap (3) is a new round.
  const big = commitFiles({ 'src/b.js': '1\n', 'src/c.js': '1\n', 'src/d.js': '1\n', 'src/e.js': '1\n' }, 'too much');
  assert.match(cli('foldin', 'fold', 'a', '--head', big, '--evidence', 'e').err, /4 files and 4 lines changed since the reviewed head \(caps 3 files, 40 lines/);
  git('reset', '-q', '--hard', reviewed);

  // Outside the fence: detect records the hit and foldin refuses.
  const outside = commitFiles({ 'docs/x.md': 'hi\n' }, 'outside');
  assert.match(cli('foldin', 'fold', 'a', '--head', outside, '--evidence', 'e').err, /no detect result for this fold; run detect\.mjs/);
  assert.equal(detect('--run', 'fold', '--unit', 'a', '--base', reviewed, '--head', outside).status, 1);
  assert.match(cli('foldin', 'fold', 'a', '--head', outside, '--evidence', 'e').err, /detect found 1 hit\(s\) on the fold/);
  git('reset', '-q', '--hard', reviewed);

  // The real fold: small, inside the fence, checked.
  const fold = commitFiles({ 'src/a.js': 'export const a = 2; // y\n', 'README.md': 'typo fixed\n' }, 'folds');
  assert.equal(detect('--run', 'fold', '--unit', 'a', '--base', reviewed, '--head', fold, '--allow', 'outside-fence:README.md').status, 0);
  ok('foldin', 'fold', 'a', '--head', fold.slice(0, 10), '--evidence', 'diff is the two folds; test/a.test.js green', '--minutes', '4');
  const f = unit('fold', 'a').rounds[0].foldin;
  assert.deepEqual([f.head, f.reviewed, f.files, f.lines, f.detect.clean], [fold, reviewed, 2, 3, true]);
  assert.deepEqual(nextOf('fold', 'a'), { id: 'a', action: 'done', step: 'merge' });
  assert.equal(ok('next', 'fold').decision, 'integrate');
  assert.match(cli('foldin', 'fold', 'a', '--head', fold, '--evidence', 'again').err, /foldin refused: next says "done"/);
  // A pass with no fold-ins merges straight away, as before; foldin is refused there.
  setup('nofold'); build('nofold', 'a'); ok('verdict', 'nofold', 'a', 'pass', '--score', '9', '--evidence', 'e');
  assert.deepEqual(nextOf('nofold', 'a'), { id: 'a', action: 'done' });
  assert.match(cli('foldin', 'nofold', 'a', '--head', 'abc1234', '--evidence', 'e').err, /foldin refused/);
  // Without a detect run that round, the reviewed head must be named.
  setup('noreview'); build('noreview', 'a'); ok('verdict', 'noreview', 'a', 'pass', '--score', '9', '--evidence', 'e', '--fold', 'rename x');
  assert.match(cli('foldin', 'noreview', 'a', '--head', fold, '--evidence', 'e').err, /no reviewed head recorded .* give --reviewed/);
});

test('fold-ins carry their severity: a high or medium one, or one in a pinned area, needs a round', () => {
  assert.deepEqual(checkFold('rename x to y'), { severity: 'low', text: 'rename x to y' });
  assert.deepEqual(checkFold('nit: comma'), { severity: 'nit', text: 'comma' });
  for (const [f, why] of [['medium: two labels unclear', /a medium finding is not a fold-in/], ['high: wrong total', /a high finding is not a fold-in/],
    ['critical: order lost', /reads as more than small/], ['fix the token check in login', /touches a pinned area/], ['round the payout amount', /touches a pinned area/], ['mask the IBAN in the log', /touches a pinned area/]])
    assert.throws(() => checkFold(f), why, f);
  setup('fsev'); build('fsev', 'a');
  assert.match(cli('verdict', 'fsev', 'a', 'pass', '--score', '9', '--evidence', 'e', '--fold', 'medium: labels').err, /a medium finding is not a fold-in/);
  assert.match(cli('verdict', 'fsev', 'a', 'pass', '--score', '9', '--evidence', 'e', '--fold', 'tidy the auth middleware').err, /pinned area/);
  // Findings: each carries its severity; the gap's severity is the worst; a pass lists no high or medium.
  assert.deepEqual(parseFinding('[medium] labels unclear'), { severity: 'medium', text: 'labels unclear' });
  assert.throws(() => parseFinding('labels unclear'), /must start with its severity/);
  assert.match(cli('verdict', 'fsev', 'a', 'pass', '--score', '9', '--evidence', 'e', '--finding', 'medium: labels').err, /pass refused: a medium finding is listed/);
  assert.match(cli('verdict', 'fsev', 'a', 'fail', '--score', '6', '--gap', 'g', '--evidence', 'e', '--severity', 'medium', '--finding', 'high: wrong total').err, /a high finding is listed/);
  ok('verdict', 'fsev', 'a', 'fail', '--score', '6', '--gap', 'labels', '--evidence', 'e', '--severity', 'medium', '--finding', 'medium: labels', '--finding', 'low: spacing');
  assert.deepEqual(unit('fsev', 'a').rounds[0].findings, [{ severity: 'medium', text: 'labels' }, { severity: 'low', text: 'spacing' }]);
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

test('finish line: the last unit open with mediums at most asks the person; shipping files every finding', () => {
  setup('fin', ['a', 'b']);
  build('fin', 'a'); ok('verdict', 'fin', 'a', 'pass', '--score', '9', '--evidence', 'e');
  // Round 1 under 8: a normal fail, another round.
  build('fin', 'b');
  ok('verdict', 'fin', 'b', 'fail', '--score', '6', '--gap', 'labels unclear', '--evidence', 'e', '--severity', 'medium');
  assert.equal(nextOf('fin', 'b').action, 'build', 'round 1 below 8 does not reach the finish line');
  assert.match(cli('ask', 'fin', '--finish', 'b').err, /ask --finish refused: next says "build"/);
  build('fin', 'b');
  ok('verdict', 'fin', 'b', 'fail', '--score', '8', '--gap', 'two labels unclear', '--evidence', 'e', '--severity', 'medium', '--finding', 'medium: two labels unclear', '--finding', 'low: spacing on the card');
  const d = nextOf('fin', 'b');
  assert.equal(d.action, 'ask-person');
  assert.equal(d.question.header, 'Finish line'); assert.match(d.question.question, /score 8.*2 findings, none high: medium: two labels unclear; low: spacing on the card/);
  assert.deepEqual(d.question.options.map((o) => o.split('|')[0]), ['Ship with follow-ups', 'One more round', 'Stop']);
  assert.match(d.step, /run\.mjs ask fin --finish b/);
  assert.match(cli('start', 'fin', 'b').err, /start refused: next says "ask-person"/);
  assert.match(cli('ask', 'fin', '--finish', 'b', '--header', 'x').err, /--header does not go with --finish/);
  const q = ok('ask', 'fin', '--finish', 'b').asked;
  assert.match(cli('ask', 'fin', '--finish', 'b').err, /already asked as q1/);
  assert.equal(nextOf('fin', 'b').asked, q);
  // The lead's own pick does not count, nor words that refuse.
  ok('answer', 'fin', q, '--choice', 'Ship with follow-ups', '--by', 'lead');
  assert.match(nextOf('fin', 'b').reason, /not one option picked by the person/);
  ok('answer', 'fin', q, '--choice', 'Ship with follow-ups', '--by', 'person', '--confirm', 'no, do not ship');
  assert.match(nextOf('fin', 'b').reason, /do not clearly say it/);
  ok('answer', 'fin', q, '--choice', 'Ship with follow-ups', '--by', 'person', '--confirm', 'ship it, file the labels');
  const shipped = nextOf('fin', 'b');
  assert.equal(shipped.action, 'done'); assert.match(shipped.reason, /shipped with follow-ups \(q1\)/);
  const s = state('fin');
  assert.equal(s.units[1].status, 'pass'); assert.deepEqual([s.units[1].shipped.answer, s.units[1].shipped.score], ['q1', 8]);
  const fups = s.notes.filter((n) => n.kind === 'follow-up' && n.shipped === 'q1').map((n) => n.text);
  assert.deepEqual(fups, ['b (shipped, medium): two labels unclear', 'b (shipped, low): spacing on the card']);
  assert.ok(s.notes.some((n) => n.kind === 'decision' && n.answers === 'q1'));
  // Shown honestly: show, the HUD badge, the unit page, stats and the gaps.
  assert.match(cli('show', 'fin').out, /\nb +shipped +2\/4 .*\n.*Shipped with follow-ups \(score 8\) on try 2/i);
  const hud = readFileSync(join(dir, 'runs', 'fin', 'hud.html'), 'utf8');
  assert.match(hud, /Shipped with follow-ups \(score 8\)/);
  assert.match(readFileSync(join(dir, 'runs', 'fin', 'units', 'b.html'), 'utf8'), /Shipped with follow-ups \(score 8\)/);
  const gl = ok('gaps', '--json').filter((g) => g.run === 'fin');
  assert.deepEqual(gl.map((g) => g.from), ['shipped with follow-ups (q1)', 'shipped with follow-ups (q1)']);
  ok('integrate', 'fin', 'pass', '--evidence', 'e'); ok('close', 'fin', '--outcome', 'done');
  const st = ok('stats');
  assert.equal(st.shipped, 1, 'a shipped unit counts apart from passes');
});

test('finish line: an open high from any critic, a specialist included, never offers Ship', () => {
  ok('init', 'fsp', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'fsp', 'a', '--bar', 'b', '--specialist', 'security'); ok('freeze', 'fsp');
  build('fsp', 'a');
  ok('verdict', 'fsp', 'a', 'fail', '--score', '4', '--gap', 'timing oracle', '--evidence', 'e', '--specialist', 'security', '--severity', 'high');
  ok('verdict', 'fsp', 'a', 'fail', '--score', '8', '--gap', 'labels', '--evidence', 'e', '--severity', 'medium');
  const r = unit('fsp', 'a').rounds[0];
  assert.deepEqual(openFindings(r).map((f) => [f.by, f.severity]), [['critic', 'medium'], ['security', 'high']]);
  assert.equal(nextOf('fsp', 'a').action, 'build', 'the specialist\'s high keeps it a normal round');
  // An older round with no severity counts as high.
  assert.equal(openFindings({ verdict: 'fail', gap: 'g' })[0].severity, 'high');
});

test('finish line: "one more round" is recorded like extend and keeps the same-gap rule; "Stop" stops it', () => {
  ok('init', 'fin2', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '2'); ok('add', 'fin2', 'a', '--bar', 'b'); ok('freeze', 'fin2');
  build('fin2', 'a'); ok('verdict', 'fin2', 'a', 'fail', '--score', '6', '--gap', 'labels', '--cause', 'label copy', '--evidence', 'e', '--severity', 'high');
  build('fin2', 'a'); ok('verdict', 'fin2', 'a', 'fail', '--score', '8', '--gap', 'labels again', '--cause', 'label copy', '--evidence', 'e', '--severity', 'medium');
  const q = ok('ask', 'fin2', '--finish', 'a').asked;
  ok('answer', 'fin2', q, '--choice', 'One more round', '--by', 'person', '--confirm', 'one more round please');
  const d = nextOf('fin2', 'a');
  assert.equal(d.action, 'change-strategy', 'the same cause twice still asks for a new approach');
  const s = state('fin2');
  assert.equal(s.units[0].extraRounds, 1, 'the cap is lifted for one round');
  assert.match(s.notes.find((n) => n.kind === 'decision' && n.answers === q).text, /one more round \(now 3\).*their words: "one more round please".*same-gap and no-progress rules still apply/);
  ok('strategy', 'fin2', 'a', '--text', 'rewrite the labels from the copy store');
  build('fin2', 'a'); ok('verdict', 'fin2', 'a', 'fail', '--score', '9', '--gap', 'one label', '--cause', 'one label left', '--evidence', 'e', '--severity', 'medium');
  const q2 = ok('ask', 'fin2', '--finish', 'a').asked;
  assert.notEqual(q2, q, 'a new verdict asks again');
  ok('answer', 'fin2', q2, '--choice', 'Stop', '--by', 'person', '--confirm', 'stop it');
  assert.equal(nextOf('fin2', 'a').action, 'stop');
  assert.match(unit('fin2', 'a').stopReason, /the person chose stop \(q2\)/);
});

test('finish line: round 1 reaches it only at a score of 8 or more', () => {
  setup('fin3'); build('fin3', 'a');
  ok('verdict', 'fin3', 'a', 'fail', '--score', '8.5', '--gap', 'labels', '--evidence', 'e', '--severity', 'medium');
  assert.equal(nextOf('fin3', 'a').action, 'ask-person');
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
  // Still watched for silence: a critic quiet past the stale limit is checked on.
  s.units[1].judgingAt = new Date(t0 + 3 * 3600_000).toISOString();
  s.units[1].heartbeatAt = new Date(t0 + 3 * 3600_000).toISOString();
  assert.equal(decideUnit(s.units[1], s, Date.now()).action, 'check-stale');
});

test('the open-ended check: no note on lines shaped like real bars, a note on u1213 and its kind', () => {
  const f = JSON.parse(readFileSync(join(scripts, 'test', 'fixtures', 'bar-lines.json'), 'utf8'));
  for (const line of f.fine) assert.deepEqual(openWords(line), [], line);
  for (const line of f.open) assert.ok(openWords(line).length, line);
  assert.deepEqual(openWords(f.open[0]), ['a class named by a quoted phrase']);
});

test('init, add and behave note an open-ended line; --accept-open silences it and is recorded', () => {
  const w = ok('init', 'open', '--goal', 'g', '--bar', 'catch every leaked secret', '--fence', 'f');
  assert.match(w.warning, /check this line, it may be open-ended: the bar \(catch every\).*--accept-open/);
  assert.equal(ok('init', 'open2', '--goal', 'g', '--bar', 'catch every leaked secret', '--fence', 'f', '--accept-open').warning, undefined);
  assert.ok(state('open2').notes.some((n) => n.kind === 'bar' && /kept an open-ended line on purpose/.test(n.text)));
  assert.match(ok('add', 'open', 'a', '--bar', 'b', '--behaviour', 'every message that names the employer is masked').warning, /a B1 \(a class named by its wording\)/);
  assert.equal(ok('add', 'open', 'b', '--bar', 'every route listed in routes.md returns 403').warning, undefined);
  assert.match(ok('behave', 'open', 'b', '--text', 'It should never log a token anywhere').warning, /never … anywhere/);
  ok('behave', 'open', 'b', '--text', 'It should catch every secret', '--accept-open');
  assert.equal(state('open').notes.filter((n) => n.kind === 'bar').length, 1);
});

test('cost: start, built and verdict record what the harness reported; show, stats and the HUD sum it', () => {
  assert.equal(costEntry({}, { step: 'built', role: 'builder', at: 'x' }), null);
  assert.throws(() => costEntry({ 'tokens-in': '1.5' }, { step: 's', role: 'r', at: 'x' }), /whole number/);
  assert.throws(() => costEntry({ cost: '0.42' }, { step: 's', role: 'r', at: 'x' }), /currency code/);
  assert.throws(() => costEntry({ cost: '0.42 ABC' }, { step: 's', role: 'r', at: 'x' }), /not an ISO 4217 currency code/);
  // A recorded zero is a zero, not "not recorded".
  const zero = costEntry({ 'tokens-in': '0', minutes: '0', cost: '0 USD' }, { step: 's', role: 'r', at: 'x' });
  assert.equal(costLine(runCost({ units: [{ costs: [zero] }] })), '0 in tokens · 0 min · 0 USD');
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
