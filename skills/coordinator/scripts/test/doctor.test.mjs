// doctor: each check passes and fails on a fake setup, and nothing it prints carries a token.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  codexCheck, contextCheck, dashboardsCheck, diagnose, format, ghCheck, gitCheck, lessonsCheck, locksCheck,
  nodeCheck, realExec, settingsCheck, stateDirCheck, versionCheck, worktreesCheck,
} from '../lib/doctor.mjs';
import { checkSettings } from '../lib/settings.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'coord-doctor-'));
after(() => rmSync(root, { recursive: true, force: true }));
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0;
const fresh = () => { const d = join(root, `p${++n}`); mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const repo = () => { const d = fresh(); git(d, 'init', '-q'); return d; };
// A fake command runner: { 'gh --version': {status, stdout}, … }; unknown commands are "not installed".
const fake = (table) => (cmd, args) => table[[cmd, ...args].join(' ')] ?? (table[cmd] === undefined ? { missing: true, status: null, stdout: '', stderr: '' } : table[cmd]);
const ctx = (o = {}) => { const p = o.project ?? fresh(); return { project: p, base: join(p, '.coordinator'), globalBase: join(p, '.global'), home: p, version: '0.6.0', online: true, exec: realExec, ...o }; };

test('node: 18+ passes, older fails', () => {
  assert.equal(nodeCheck({ node: '22.1.0' }).status, 'ok');
  const r = nodeCheck({ node: '16.20.0' });
  assert.equal(r.status, 'fail'); assert.match(r.fix, /Node 18/);
});

test('version: skipped offline, warns when a newer release exists, ok when current', () => {
  assert.equal(versionCheck(ctx({ online: false })).status, 'skip');
  const tags = (t) => fake({ [`git ls-remote --tags --refs https://github.com/mindmakr/coordinator`]: { status: 0, stdout: t.map((x) => `abc\trefs/tags/${x}`).join('\n') } });
  assert.equal(versionCheck(ctx({ exec: tags(['v0.5.0', 'v0.7.0']) })).status, 'warn');
  assert.equal(versionCheck(ctx({ exec: tags(['v0.5.0', 'v0.6.0']) })).status, 'ok');
  assert.equal(versionCheck(ctx({ exec: fake({}) })).status, 'skip', 'unreachable is a skip, not a fail');
});

test('gh: missing, logged out, short scopes and good scopes; the token never shows', () => {
  assert.equal(ghCheck(ctx({ exec: fake({}) })).status, 'fail');
  const auth = (status, text) => fake({ 'gh --version': { status: 0, stdout: 'gh 2.60' }, 'gh auth status --hostname github.com': { status, stdout: '', stderr: text } });
  assert.equal(ghCheck(ctx({ exec: auth(1, 'You are not logged into any GitHub hosts') })).status, 'fail');
  const block = (scopes) => `github.com\n  ✓ Logged in to github.com account someone (keyring)\n  - Active account: true\n  - Token: ${TOKEN}\n  - Token scopes: ${scopes}\n`;
  const ok = ghCheck(ctx({ exec: auth(0, block("'gist', 'project', 'read:org', 'repo'")) }));
  assert.equal(ok.status, 'ok');
  assert.equal(ghCheck(ctx({ exec: auth(0, block("'gist', 'repo'")) })).status, 'warn');
  assert.equal(ghCheck(ctx({ exec: auth(0, block("'gist'")) })).status, 'fail');
  assert.equal(ghCheck(ctx({ exec: auth(0, block('none')) })).status, 'warn');
  for (const r of [ok, ghCheck(ctx({ exec: auth(0, block("'gist'")) }))]) assert.ok(!JSON.stringify(r).includes(TOKEN));
  assert.equal(ghCheck(ctx({ online: false, exec: auth(0, '') })).status, 'skip');
});

test('git: a repo with a remote passes without its credentials; no repo fails; no remote warns', () => {
  const p = repo();
  assert.equal(gitCheck(ctx({ project: p })).status, 'warn');
  git(p, 'remote', 'add', 'origin', `https://someone:${TOKEN}@github.com/acme/web.git`);
  const r = gitCheck(ctx({ project: p }));
  assert.equal(r.status, 'ok');
  assert.match(r.text, /https:\/\/github\.com\/acme\/web\.git/);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes('someone'));
  const outside = mkdtempSync(join(tmpdir(), 'coord-nogit-'));
  try { assert.equal(gitCheck(ctx({ project: outside })).status, 'fail'); } finally { rmSync(outside, { recursive: true, force: true }); }
});

test('context: missing warns, a stale command warns, current commands pass', () => {
  const p = fresh();
  assert.equal(contextCheck(ctx({ project: p })).status, 'warn');
  writeFileSync(join(p, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', verify: 'x' } }));
  mkdirSync(join(p, 'backend'));
  writeFileSync(join(p, 'backend', 'package.json'), JSON.stringify({ scripts: { 'db:check': 'x' } }));
  writeFileSync(join(p, 'COORDINATOR.md'), '## Checks\n- `npm test` and `npm run verify`, `npm ci`\n- `cd backend && npm run db:check`\n');
  assert.equal(contextCheck(ctx({ project: p })).status, 'ok');
  writeFileSync(join(p, 'COORDINATOR.md'), '## Checks\n- `npm run lint` and `cd backend && npm run db:gone`\n');
  const r = contextCheck(ctx({ project: p }));
  assert.equal(r.status, 'warn'); assert.match(r.text, /npm run lint/); assert.match(r.text, /backend: npm run db:gone/);
  writeFileSync(join(p, 'COORDINATOR.md'), 'Theme: `missing.css`\n');
  assert.match(contextCheck(ctx({ project: p })).text, /Theme/);
});

test('state-dir: writable and ignored passes, not ignored warns, unwritable fails', () => {
  const p = repo();
  mkdirSync(join(p, '.coordinator'));
  assert.equal(stateDirCheck(ctx({ project: p })).status, 'warn');
  writeFileSync(join(p, '.gitignore'), '.coordinator/\n');
  assert.equal(stateDirCheck(ctx({ project: p })).status, 'ok');
  writeFileSync(join(p, 'afile'), '');
  assert.equal(stateDirCheck(ctx({ project: p, base: join(p, 'afile', 'sub', 'x') })).status, 'fail');
});

test('settings: every key checked; public state, a weak critic and a public stateRepo are caught', () => {
  const p = fresh();
  const c = ctx({ project: p });
  mkdirSync(c.base);
  const put = (v) => writeFileSync(join(c.base, 'coordinator.json'), typeof v === 'string' ? v : JSON.stringify(v));
  assert.equal(settingsCheck(c)[0].status, 'ok', 'no file is fine');
  put('{ nope');
  assert.equal(settingsCheck(c)[0].status, 'fail');
  writeFileSync(join(p, 'theme.css'), ':root{--primary:#123456}');
  put({ state: 'repo', visibility: 'private', service: 'https://coord.example.com', theme: 'theme.css', budgets: { rounds: 4, minutes: 240 }, merge: ['test'], models: { strong: 'opus', builder: 'sonnet', critic: 'opus', mechanical: 'haiku' } });
  assert.deepEqual(settingsCheck(c).map((r) => r.status), ['ok', 'ok']);
  put({ branch: 'main' });
  assert.deepEqual(settingsCheck(c).map((r) => r.status), ['fail', 'fail'], 'settings and state agree');
  const problems = (v) => checkSettings(v, p).map((x) => `${x.level}:${x.key}`);
  assert.deepEqual(problems({ visibility: 'public' }), ['fail:stateRepo']);
  assert.deepEqual(problems({ visibility: 'public', state: 'local' }), []);
  assert.deepEqual(problems({ models: false }), []);
  assert.deepEqual(problems({ models: { builder: 'opus', critic: 'sonnet' } }), [], 'no strong: no judge floor to compare');
  assert.deepEqual(problems({ models: { strong: 'opus', critic: 'sonnet', 'visual-critic': 'opus', builder: 'haiku' } }), ['warn:models']);
  assert.deepEqual(problems({ models: { strong: 'opus', integrator: 'haiku', specialist: 'sonnet' } }), ['warn:models', 'warn:models']);
  assert.deepEqual(problems({ models: { strong: 'sonnet', critic: 'opus', 'billing-migration': 'opus' } }), []);
  assert.deepEqual(problems({ models: 'opus' }), ['fail:models']);
  assert.deepEqual(problems({ service: 'http://coord.example.com' }), ['fail:service']);
  assert.deepEqual(problems({ service: `https://x:${TOKEN}@coord.example.com` }), ['fail:service']);
  assert.deepEqual(problems({ theme: 'nope.css' }), ['fail:theme']);
  assert.deepEqual(problems({ budgets: { rounds: 9 } }), ['fail:budgets']);
  assert.deepEqual(problems({ merge: ['test', 'main'] }), ['warn:merge']);
  assert.deepEqual(problems({ merge: 'test' }), ['fail:merge']);
  assert.deepEqual(problems({ state: 'cloud', colour: 'red' }), ['warn:colour', 'fail:state']);
  put({ service: `https://x:${TOKEN}@coord.example.com` });
  assert.ok(!JSON.stringify(settingsCheck(c)).includes(TOKEN), 'a bad service URL is described, never echoed');
  const vis = (v) => fake({ [`gh repo view acme/state --json visibility -q .visibility`]: { status: 0, stdout: `${v}\n` } });
  put({ stateRepo: 'acme/state' });
  assert.equal(settingsCheck({ ...c, exec: vis('PUBLIC') })[1].status, 'fail');
  assert.equal(settingsCheck({ ...c, exec: vis('PRIVATE') })[1].status, 'ok');
  assert.equal(settingsCheck({ ...c, online: false })[1].status, 'skip');
});

test('locks and dashboards: stale ones warn, live ones pass', () => {
  const c = ctx();
  mkdirSync(join(c.base, 'runs', 'r1'), { recursive: true });
  assert.equal(locksCheck(c).status, 'ok');
  const lock = join(c.base, 'runs', 'r1', 'state.json.lock');
  writeFileSync(lock, '1:2:3');
  assert.equal(locksCheck(c).status, 'ok', 'a fresh lock is in use');
  const old = (Date.now() - 120_000) / 1000; utimesSync(lock, old, old);
  assert.equal(locksCheck(c).status, 'warn');
  assert.equal(dashboardsCheck(c)[0].status, 'ok');
  writeFileSync(join(c.base, 'runs', 'r1', 'serve.json'), JSON.stringify({ pid: 999_999, port: 7600 }));
  assert.equal(dashboardsCheck({ ...c, alive: () => false, fix: false })[0].status, 'warn');
  const gone = dashboardsCheck({ ...c, alive: () => false })[0];
  assert.match(gone.text, /removed a stale dashboard record/);
  assert.ok(!existsSync(join(c.base, 'runs', 'r1', 'serve.json')), 'the stale record is removed');
  writeFileSync(join(c.base, 'runs', 'r1', 'serve.json'), JSON.stringify({ pid: 999_999, port: 7600 }));
  assert.equal(dashboardsCheck({ ...c, alive: () => true })[0].status, 'ok');
  writeFileSync(join(c.base, 'runs', 'r1', 'state.json'), JSON.stringify({ closed: { outcome: 'done' } }));
  const r = dashboardsCheck({ ...c, alive: () => true })[0];
  assert.equal(r.status, 'warn'); assert.match(r.fix, /stop pid 999999/);
});

test('worktrees: a linked node_modules warns, plain worktrees pass', () => {
  const p = repo();
  writeFileSync(join(p, 'a.txt'), 'a'); git(p, 'add', '.'); git(p, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'a');
  const wt = join(fresh(), 'wt1');
  git(p, 'worktree', 'add', '-q', wt);
  assert.equal(worktreesCheck(ctx({ project: p })).status, 'ok');
  mkdirSync(join(p, 'node_modules'));
  symlinkSync(join(p, 'node_modules'), join(wt, 'node_modules'), 'junction');
  const r = worktreesCheck(ctx({ project: p }));
  assert.equal(r.status, 'warn'); assert.match(r.fix, /rmdir/);
});

test('lessons and codex', () => {
  const c = ctx();
  assert.equal(lessonsCheck(c).status, 'ok');
  mkdirSync(c.globalBase); writeFileSync(join(c.globalBase, 'lessons.json'), '[{"id":"a"}]');
  assert.match(lessonsCheck(c).text, /1 lesson/);
  mkdirSync(c.base); writeFileSync(join(c.base, 'lessons.json'), 'oops');
  assert.equal(lessonsCheck(c).status, 'fail');
  assert.equal(codexCheck(c).status, 'skip');
  writeFileSync(join(c.project, 'AGENTS.md'), '# A\n\n## Coordinator\n- use it\n');
  assert.equal(codexCheck(c).status, 'fail');
  const skills = join(c.project, '.agents', 'skills');
  for (const s of ['coordinator', 'review']) { mkdirSync(join(skills, s), { recursive: true }); writeFileSync(join(skills, s, 'SKILL.md'), '---\n---\n'); }
  assert.equal(codexCheck(c).status, 'warn');
  for (const s of ['investigate', 'plan', 'fix', 'verify', 'visual', 'translations', 'release-notes', 'board', 'doctor']) { mkdirSync(join(skills, s), { recursive: true }); writeFileSync(join(skills, s, 'SKILL.md'), '---\n---\n'); }
  assert.equal(codexCheck(c).status, 'ok');
});

test('diagnose and format: one line per check, every status shown', () => {
  const lines = format(diagnose(ctx({ online: false, project: repo() }))).split('\n');
  for (const id of ['node', 'version', 'gh', 'git', 'context', 'state-dir', 'settings', 'state', 'locks', 'dashboards', 'artifacts', 'worktrees', 'lessons', 'codex']) assert.ok(lines.some((l) => l.split(/\s+/)[1] === id), `no ${id} line`);
});

test('the CLI: --json is machine-readable and never prints a token from the environment or config', () => {
  const p = repo();
  git(p, 'remote', 'add', 'origin', `https://someone:${TOKEN}@github.com/acme/web.git`);
  mkdirSync(join(p, '.coordinator'));
  writeFileSync(join(p, '.coordinator', 'coordinator.json'), JSON.stringify({ service: `https://u:${TOKEN}@coord.example.com` }));
  const env = { ...process.env, GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, COORDINATOR_DIR: join(p, '.coordinator') };
  const r = spawnSync(process.execPath, [join(scripts, 'doctor.mjs'), '--offline', '--json'], { cwd: p, env, encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false, 'the bad service URL fails');
  assert.equal(r.status, 1);
  assert.ok(out.checks.every((c) => ['ok', 'warn', 'fail', 'skip'].includes(c.status) && c.id && c.text));
  const text = spawnSync(process.execPath, [join(scripts, 'doctor.mjs'), '--offline'], { cwd: p, env, encoding: 'utf8' });
  for (const s of [r.stdout, r.stderr, text.stdout, text.stderr]) assert.ok(!s.includes(TOKEN), 'token printed');
  assert.match(spawnSync(process.execPath, [join(scripts, 'doctor.mjs'), '--bogus'], { cwd: p, env, encoding: 'utf8' }).stderr, /unknown option/);
});

test('init settings take effect: budgets are run defaults, state local refuses a branch push', () => {
  const p = repo();
  const base = join(p, '.coordinator'); mkdirSync(base);
  writeFileSync(join(base, 'coordinator.json'), JSON.stringify({ state: 'local', budgets: { rounds: 6, minutes: 90 } }));
  const run = (...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { cwd: p, env: { ...process.env, COORDINATOR_DIR: base }, encoding: 'utf8' });
  assert.equal(run('init', 'r1', '--goal', 'g', '--bar', 'b', '--fence', 'f').status, 0);
  const s = JSON.parse(readFileSync(join(base, 'runs', 'r1', 'state.json'), 'utf8'));
  assert.deepEqual([s.budget.maxRounds, s.budget.maxMinutes], [6, 90]);
  assert.equal(run('init', 'r2', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--max-rounds', '2').status, 0);
  assert.equal(JSON.parse(readFileSync(join(base, 'runs', 'r2', 'state.json'), 'utf8')).budget.maxRounds, 2, 'a flag still wins');
  assert.match(run('push', 'r1').stderr, /"state" is "local"/);
});

test('settings: a committed coordinator.json is flagged, and fails when it names a service or helpers', () => {
  const p = repo();
  const c = ctx({ project: p });
  mkdirSync(c.base);
  const put = (v) => writeFileSync(join(c.base, 'coordinator.json'), JSON.stringify(v));
  const trust = () => settingsCheck(c).find((r) => r.id === 'settings-trust');
  put({ service: 'https://attacker.example' });
  assert.equal(trust(), undefined, 'untracked: nothing to say');
  assert.equal(git(p, 'add', '-f', '.coordinator/coordinator.json').status, 0);
  assert.equal(trust().status, 'fail');
  assert.match(trust().text, /service/);
  assert.match(trust().fix, /git rm --cached/);
  put({ helpers: { provider: 'ollama' }, service: 'https://attacker.example' });
  assert.match(trust().text, /service and helpers/);
  put({ budgets: { rounds: 4 } });
  assert.equal(trust().status, 'warn', 'tracked but harmless: still meant to be ignored');
});
