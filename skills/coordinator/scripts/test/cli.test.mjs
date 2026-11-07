import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function cli(script, ...args) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout || 'null') : null, err: r.stderr };
}
const run = (...a) => cli('run.mjs', ...a);

test('a run goes from split to done, and the workbench follows it', () => {
  assert.equal(run('init', 'r1', '--goal', 'fix totals', '--bar', 'red test green', '--fence', 'backend/', '--tag', 'code').code, 0);
  assert.equal(run('add', 'r1', 'api', '--bar', 'totals test passes').code, 0);
  assert.equal(run('next', 'r1').out.decision, 'split');
  run('freeze', 'r1');
  assert.equal(run('next', 'r1').out.units[0].action, 'build');
  run('start', 'r1', 'api'); run('built', 'r1', 'api');
  assert.equal(run('next', 'r1').out.units[0].action, 'judge');
  run('verdict', 'r1', 'api', 'pass', '--evidence', 'vitest: 12 passed', '--score', '9');
  assert.equal(run('next', 'r1').out.decision, 'integrate');
  run('integrate', 'r1', 'pass', '--evidence', 'full suite green');
  assert.equal(run('next', 'r1').out.decision, 'done');
  assert.match(readFileSync(join(dir, 'runs', 'r1', 'workbench.md'), 'utf8'), /# Run r1: done/);
  assert.equal(run('close', 'r1', '--outcome', 'done').code, 0);
  assert.equal(run('note', 'r1', '--kind', 'info', '--text', 'late').code, 1, 'a closed run refuses changes');
  assert.equal(run('stats', '--tag', 'code').out.medianRoundsToPass, 1);
});

test('a PASS without evidence is recorded as a FAIL', () => {
  run('init', 'r2', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'r2', 'u', '--bar', 'b'); run('freeze', 'r2'); run('start', 'r2', 'u'); run('built', 'r2', 'u');
  run('verdict', 'r2', 'u', 'pass');
  const state = JSON.parse(readFileSync(join(dir, 'runs', 'r2', 'state.json'), 'utf8'));
  assert.deepEqual([state.units[0].status, state.units[0].rounds[0].gap], ['open', 'PASS claimed without evidence']);
});

test('scope is capped after freeze and unsafe ids are refused', () => {
  run('init', 'r3', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-added', '1');
  run('add', 'r3', 'a', '--bar', 'b'); run('freeze', 'r3');
  assert.equal(run('add', 'r3', 'b', '--bar', 'b').code, 1, 'needs --reason after freeze');
  assert.equal(run('add', 'r3', 'b', '--bar', 'b', '--reason', 'found in review').code, 0);
  assert.equal(run('add', 'r3', 'c', '--bar', 'b', '--reason', 'more').code, 1, 'cap reached');
  assert.equal(run('init', '../escape', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 1);
  assert.equal(existsSync(join(dir, '..', 'escape')), false);
});

test('next records stops so they survive a restart', () => {
  run('init', 'r4', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'r4', 'u', '--bar', 'b'); run('freeze', 'r4'); run('start', 'r4', 'u'); run('built', 'r4', 'u');
  run('verdict', 'r4', 'u', 'fail', '--severity', 'high', '--gap', 'wrong total', '--evidence', 'test output', '--score', '3');
  assert.equal(run('next', 'r4').out.units[0].action, 'stop');
  const state = JSON.parse(readFileSync(join(dir, 'runs', 'r4', 'state.json'), 'utf8'));
  assert.deepEqual([state.units[0].status, state.units[0].stopReason], ['stopped', 'budget: rounds']);
});

test('steps the loop did not ask for are refused', () => {
  run('init', 'r5', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '1');
  run('add', 'r5', 'a', '--bar', 'b'); run('add', 'r5', 'b', '--bar', 'b', '--after', 'a');
  assert.equal(run('start', 'r5', 'a').code, 1, 'not frozen');
  run('freeze', 'r5');
  assert.equal(run('start', 'r5', 'b').code, 1, 'b waits for a');
  assert.equal(run('verdict', 'r5', 'a', 'pass', '--evidence', 'x').code, 1, 'never built');
  assert.equal(run('strategy', 'r5', 'a', '--text', 'x').code, 1, 'not asked for');
  assert.equal(run('integrate', 'r5', 'pass', '--evidence', 'x').code, 1, 'units not done');
  run('start', 'r5', 'a'); run('built', 'r5', 'a');
  run('verdict', 'r5', 'a', 'fail', '--severity', 'high', '--gap', 'g', '--evidence', 'e', '--score', '3');
  assert.equal(run('start', 'r5', 'a').code, 1, 'round budget spent');
  assert.deepEqual(run('next', 'r5').out.units.map((u) => u.action), ['stop', 'stop'], 'a stopped, b blocked');
  assert.equal(run('next', 'r5').out.decision, 'stopped');
});

test('default budgets reach the stuck stop before the round budget', () => {
  run('init', 'r6', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'r6', 'u', '--bar', 'b'); run('freeze', 'r6');
  const round = () => { run('start', 'r6', 'u'); run('built', 'r6', 'u'); run('verdict', 'r6', 'u', 'fail', '--severity', 'high', '--gap', 'total off by one cycle', '--evidence', 'e', '--score', '3'); };
  round(); round();
  assert.equal(run('next', 'r6').out.units[0].action, 'change-strategy');
  assert.equal(run('strategy', 'r6', 'u', '--text', 'compute from cycle dates').code, 0);
  round();
  assert.deepEqual(run('next', 'r6').out.units[0], { id: 'u', action: 'stop', reason: 'stuck: same gap after a change of strategy' });
});

test('options: --k=v, dash-led values, unknown flags, decimal scores', () => {
  assert.equal(run('init', 'r7', '--goal=g', '--bar', 'b', '--fence', 'f', '--max-rounds=2').code, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', 'r7', 'state.json'), 'utf8')).budget.maxRounds, 2);
  assert.equal(run('note', 'r7', '--kind', 'info', '--txt', 'typo').code, 1, 'unknown flag refused');
  run('add', 'r7', 'u', '--bar', 'b'); run('freeze', 'r7'); run('start', 'r7', 'u'); run('built', 'r7', 'u');
  assert.equal(run('verdict', 'r7', 'u', 'pass', '--evidence', '--- PASS: TestTotals', '--score', '7.5').code, 0);
  const u = JSON.parse(readFileSync(join(dir, 'runs', 'r7', 'state.json'), 'utf8')).units[0];
  assert.deepEqual([u.status, u.rounds[0].evidence, u.rounds[0].score], ['pass', '--- PASS: TestTotals', 7.5]);
});

test('secrets are masked in run state, and junk folders do not break list', () => {
  run('init', 'r8', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('note', 'r8', '--kind', 'info', '--text', 'db at postgres://app:hunter22@db:5432/x token=ghp_abcdefghijklmnopqrstuvwxyz0123');
  const raw = readFileSync(join(dir, 'runs', 'r8', 'state.json'), 'utf8');
  assert.doesNotMatch(raw, /hunter22|ghp_abc/);
  mkdirSync(join(dir, 'runs', 'My Run'), { recursive: true });
  assert.equal(run('list').code, 0);
  assert.equal(run('init', 'CON', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 1, 'reserved name refused');
});

test('detect refuses option-like refs and reads the fence from the run', () => {
  const d = (...a) => spawnSync(process.execPath, [join(scripts, 'detect.mjs'), ...a], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  assert.equal(d('--base', '-Ofoo').status, 2);
  run('init', 'r9', '--goal', 'g', '--bar', 'b', '--fence', 'backend only', '--paths', 'backend');
  const f = join(dir, 'x.diff');
  writeFileSync(f, 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n+hi\n');
  const r = d('--diff-file', f, '--run', 'r9');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).hits[0].rule, 'outside-fence');
});

test('a builder in a git worktree reaches the lead\'s run without any setup', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-git-'));
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('worktree', 'add', '-q', '--detach', join(root, 'wt'));
  const env = { ...process.env }; delete env.COORDINATOR_DIR;
  const at = (cwd, ...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { cwd, env, encoding: 'utf8' });
  at(root, 'init', 'w', '--goal', 'g', '--bar', 'b', '--fence', 'f'); at(root, 'add', 'w', 'a', '--bar', 'b'); at(root, 'freeze', 'w'); at(root, 'start', 'w', 'a');
  const beat = at(join(root, 'wt'), 'beat', 'w', 'a');
  assert.equal(beat.status, 0, beat.stderr);
  assert.match(JSON.parse(at(join(root, 'wt'), 'where').stdout).stateDir.replace(/\\/g, '/'), /coordinator-git-[^/]+\/\.coordinator$/);
  rmSync(root, { recursive: true, force: true });
});

test('a stale critic is re-sent without throwing away the build', () => {
  run('init', 'r10', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--stale-minutes', '5');
  run('add', 'r10', 'a', '--bar', 'b'); run('freeze', 'r10'); run('start', 'r10', 'a'); run('built', 'r10', 'a');
  const file = join(dir, 'runs', 'r10', 'state.json');
  const s = JSON.parse(readFileSync(file, 'utf8')); s.units[0].heartbeatAt = new Date(Date.now() - 600_000).toISOString(); writeFileSync(file, JSON.stringify(s));
  assert.deepEqual(run('next', 'r10').out.units[0], { id: 'a', action: 'check-stale', phase: 'judging' });
  assert.equal(run('start', 'r10', 'a').code, 1, 'restarting the builder is refused for a stale critic');
  assert.equal(run('beat', 'r10', 'a').code, 0);
  assert.equal(run('verdict', 'r10', 'a', 'pass', '--evidence', 'ok').code, 0);
});

test('stops hold without next: an expired run refuses built and verdict; close is gated', () => {
  run('init', 'r11', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'r11', 'a', '--bar', 'b'); run('freeze', 'r11'); run('start', 'r11', 'a');
  assert.equal(run('close', 'r11', '--outcome', 'stopped').code, 1, 'unit in progress');
  const file = join(dir, 'runs', 'r11', 'state.json');
  const s = JSON.parse(readFileSync(file, 'utf8')); s.createdAt = '2020-01-01T00:00:00.000Z'; writeFileSync(file, JSON.stringify(s));
  assert.equal(run('built', 'r11', 'a').code, 1);
  assert.equal(run('next', 'r11').out.decision, 'stopped');
  assert.equal(run('close', 'r11', '--outcome', 'done').code, 1, 'done only when the run is done');
  assert.equal(run('close', 'r11', '--outcome', 'stopped').code, 0);
  assert.equal(run('note', 'r11', '--kind', 'follow-up', '--text', 'upstream: x').code, 0, 'retro follow-ups after close');
  assert.equal(run('init', 'r12', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds').code, 1, 'a number option needs a value');
});

test('detect: real git quoting and renames, a mistyped run', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-det-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'été.test.js'), 'expect(a).toBe(1)\nexpect(b).toBe(2)\n');
  writeFileSync(join(root, 'src', 'b.test.js'), 'expect(c).toBe(3)\n');
  git('add', '.'); git('commit', '-q', '-m', 'one');
  writeFileSync(join(root, 'src', 'été.test.js'), 'expect(a).toBe(1)\n');
  git('mv', 'src/b.test.js', 'src/c.test.js'); git('add', '.'); git('commit', '-q', '-m', 'two');
  const d = (...a) => spawnSync(process.execPath, [join(scripts, 'detect.mjs'), ...a], { cwd: root, env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  const r = d('--base', 'HEAD~1');
  assert.deepEqual(JSON.parse(r.stdout).hits.map((h) => `${h.rule} ${h.file}`), ['assertions-removed src/été.test.js']);
  assert.equal(d('--base', 'HEAD~1', '--run', 'no-such-run').status, 2);
  rmSync(root, { recursive: true, force: true });
});

test('lessons dedupe, rank, refuse secrets and prune', () => {
  const l = (...a) => cli('lessons.mjs', ...a, '--scope', 'project');
  const first = l('add', '--tag', 'code', '--text', 'Seed data must use the simulated clock.', '--from', 'r1');
  assert.equal(first.out.added, true);
  assert.equal(l('add', '--tag', 'code', '--text', 'seed data must use the SIMULATED clock').out.added, false);
  l('add', '--tag', 'code', '--text', 'Run the full suite on the PR head, not the worktree.');
  const top = l('list', '--tag', 'code').out;
  assert.equal(top[0].id, first.out.id);
  assert.equal(top[0].seen, 2);
  for (const secret of ['token = ghp_abcdefghijklmnopqrstuvwxyz0123', 'api_key=abc123def456', 'Authorization: Bearer abcdefghijklmnop1234', 'use postgres://user:pass@host/db', 'the password is hunter22x', 'sk_live_abcdefghijklmnop1234']) {
    assert.equal(l('add', '--text', secret).code, 1, secret);
  }
  assert.equal(l('add', '--tag', 'code', '--text', 'Run the full suite on the PR head and not the worktree').out.added, false, 'near-duplicate merged');
  l('add', '--tag', 'db', '--text', 'Run the migrations before the seed script');
  assert.equal(l('add', '--tag', 'db', '--text', 'Run the seed script before the migrations').out.added, true, 'opposite lessons stay apart');
  assert.equal(l('drop', 'abcdef1234').code, 1, 'missing id is an error');
  assert.equal(cli('lessons.mjs', 'list', '--scope', 'nowhere').code, 1, 'bad scope is a clean error');
  assert.equal(l('prune', '--keep', '1').out.removed, 3);
  assert.equal(l('list').out.length, 1);
});

test('round 4: unicode lessons, reset, the detect gate on pass, close after expiry, quoted where', () => {
  const l = (...a) => cli('lessons.mjs', ...a, '--scope', 'project');
  const a = l('add', '--tag', 'ur', '--text', 'مايگریشن را قبل از داده بذری اجرا کنید');
  const b = l('add', '--tag', 'ur', '--text', 'داده بذری را قبل از مايگریشن اجرا کنید');
  assert.equal(b.out.added, true, 'an opposite lesson in another script stays separate');
  assert.notEqual(a.out.id, b.out.id);

  run('init', 'r20', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--paths', 'src');
  run('add', 'r20', 'u', '--bar', 'b'); run('freeze', 'r20'); run('start', 'r20', 'u');
  assert.equal(run('reset', 'r20', 'u', '--reason', 'lead crashed, no artifact').code, 0);
  assert.equal(run('next', 'r20').out.units[0].action, 'build');
  run('start', 'r20', 'u'); run('built', 'r20', 'u');
  assert.equal(run('verdict', 'r20', 'u', 'pass', '--evidence', 'ok').code, 1, 'no detect result yet');
  const f = join(dir, 'clean.diff');
  writeFileSync(f, 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n');
  const d = spawnSync(process.execPath, [join(scripts, 'detect.mjs'), '--diff-file', f, '--run', 'r20', '--unit', 'u'], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  assert.equal(d.status, 0, d.stderr);
  assert.equal(run('verdict', 'r20', 'u', 'pass', '--evidence', 'ok').code, 0);

  run('init', 'r21', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'r21', 'u', '--bar', 'b'); run('freeze', 'r21'); run('start', 'r21', 'u');
  const file = join(dir, 'runs', 'r21', 'state.json');
  const s = JSON.parse(readFileSync(file, 'utf8')); s.createdAt = '2020-01-01T00:00:00.000Z'; writeFileSync(file, JSON.stringify(s));
  assert.equal(run('close', 'r21', '--outcome', 'stopped').code, 0, 'close applies the expired budget itself');

  assert.match(run('where').out.env, /^COORDINATOR_DIR='[^']+'$/);
  assert.equal(run('where').out.env.includes('\\'), false, 'no backslashes');
});

test('round 5: empty diffs prove nothing, early close needs a reason, fails need a gap, flags once', () => {
  run('init', 'r30', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--paths', 'src');
  run('add', 'r30', 'u', '--bar', 'b'); run('add', 'r30', 'v', '--bar', 'b'); run('freeze', 'r30');
  run('start', 'r30', 'u'); run('built', 'r30', 'u');
  const empty = join(dir, 'empty.diff'); writeFileSync(empty, '');
  const d = spawnSync(process.execPath, [join(scripts, 'detect.mjs'), '--diff-file', empty, '--run', 'r30', '--unit', 'u'], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  assert.equal(d.status, 2, 'an empty diff is refused');
  assert.equal(run('verdict', 'r30', 'u', 'pass', '--evidence', 'ok').code, 1, 'so the PASS stays refused');
  assert.equal(run('verdict', 'r30', 'u', 'fail', '--severity', 'high', '--evidence', 'e', '--score', '3').code, 1, 'a fail needs a gap');
  assert.equal(run('verdict', 'r30', 'u', 'fail', '--severity', 'high', '--evidence', 'e', '--score', ' ', '--gap', 'g').code, 1, 'a blank score is refused');
  assert.equal(run('note', 'r30', '--kind', 'info', '--text', 'a', '--text', 'b').code, 1, 'a flag given twice');
  run('verdict', 'r30', 'u', 'fail', '--severity', 'high', '--evidence', 'e', '--score', '3', '--gap', 'wrong total');
  assert.equal(run('close', 'r30', '--outcome', 'partial').code, 1, 'quitting early needs a reason');
  assert.equal(run('close', 'r30', '--outcome', 'partial', '--reason', 'owner moved priorities').code, 0);
});

test('long opposite lessons stay apart', () => {
  const l = (...a) => cli('lessons.mjs', ...a, '--scope', 'project');
  l('add', '--tag', 'ui', '--text', 'Always truncate long Arabic labels on phones and never wrap them onto two lines');
  assert.equal(l('add', '--tag', 'ui', '--text', 'Never truncate long Arabic labels on phones and always wrap them onto two lines').out.added, true);
  l('add', '--tag', 'db', '--text', 'Run the seed script before migrations in every test run on the shared database');
  assert.equal(l('add', '--tag', 'db', '--text', 'Run migrations before the seed script in every test run on the shared database').out.added, true);
});

test('verdict --cause is stored and drives change-strategy; show and hud.html follow the state', () => {
  run('init', 'r40', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'r40', 'u', '--bar', 'b'); run('freeze', 'r40');
  const round = (gap) => { run('start', 'r40', 'u'); run('built', 'r40', 'u'); return run('verdict', 'r40', 'u', 'fail', '--severity', 'high', '--gap', gap, '--cause', 'hand-rolled parser', '--evidence', 'e', '--score', '4'); };
  assert.equal(round('<script>x</script> plural keys misread').code, 0);
  round('rich-text tags ignored');
  const u = JSON.parse(readFileSync(join(dir, 'runs', 'r40', 'state.json'), 'utf8')).units[0];
  assert.deepEqual(u.rounds.map((r) => r.cause), ['hand-rolled parser', 'hand-rolled parser']);
  assert.equal(run('next', 'r40').out.units[0].action, 'change-strategy');
  const html = readFileSync(join(dir, 'runs', 'r40', 'hud.html'), 'utf8');
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/i);
  const show = spawnSync(process.execPath, [join(scripts, 'run.mjs'), 'show', 'r40'], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' }).stdout;
  assert.match(show, /budget {2}time \d+\/240 min · units 1\/6/);
  assert.match(show, /next {4}change-strategy u/);
  const h = run('hud', 'r40');
  assert.equal(h.code, 0);
  assert.equal(existsSync(h.out.file), true);
});

test('add takes --title and an http(s) --link; note takes situation, --recommend and --answers', () => {
  run('init', 'r50', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  assert.equal(run('add', 'r50', 'u', '--bar', 'b', '--link', 'javascript:alert(1)').code, 1, 'only web links');
  assert.equal(run('add', 'r50', 'u', '--bar', 'b', '--title', '#1206 Security gaps', '--link', 'https://github.com/o/r/issues/1206').code, 0);
  run('freeze', 'r50');
  assert.equal(run('note', 'r50', '--kind', 'situation', '--text', 'One builder on the security gaps.').code, 0);
  assert.equal(run('note', 'r50', '--kind', 'info', '--text', 'x', '--recommend', 'y').code, 1, '--recommend is for questions');
  assert.equal(run('note', 'r50', '--kind', 'question', '--text', 'Merge it?', '--recommend', 'yes').code, 0);
  assert.equal(run('note', 'r50', '--kind', 'decision', '--text', 'no', '--answers', 'q2').code, 1, 'no such question');
  let html = readFileSync(join(dir, 'runs', 'r50', 'hud.html'), 'utf8');
  assert.match(html, /One builder on the security gaps\./);
  assert.match(html, /u · #1206 Security gaps<\/span>.*<a href="https:\/\/github.com\/o\/r\/issues\/1206" target="_blank" rel="noopener noreferrer">/s);
  assert.match(html, /<b>q1<\/b> Merge it\?<\/p><p class="rec">Recommended: yes/);
  assert.equal(run('note', 'r50', '--kind', 'decision', '--text', 'merge approved', '--answers', 'q1').code, 0);
  html = readFileSync(join(dir, 'runs', 'r50', 'hud.html'), 'utf8');
  assert.match(html, /Nothing needs you\./);
});
