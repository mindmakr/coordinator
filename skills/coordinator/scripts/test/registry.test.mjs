// The machine-wide run register, the harness and version stamp, and the global dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, harnessOf, origin, versionWarning } from '../lib/harness.mjs';
import { entryFor, readRegistry, register, registryFile } from '../lib/registry.mjs';
import { loadRun, updateRun, parseLog } from '../lib/events.mjs';
import { decide } from '../lib/rules.mjs';
import { view } from '../lib/view.mjs';
import { hud } from '../lib/hud.mjs';
import { VERSION } from '../lib/version.mjs';
import { projectPage } from '../lib/dashboard.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coord-reg-'));
const home = join(tmp, 'home');
const state = (name) => join(tmp, name, '.coordinator');
// Every run.mjs here writes to this test's own home, never the person's ~/.coordinator.
const env = (name, extra = {}) => ({ ...process.env, COORDINATOR_DIR: state(name), COORDINATOR_HOME: home, COORDINATOR_HARNESS: '', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '', ...extra });
const cli = (name, args, extra) => {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: tmp, env: env(name, extra), encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out, raw: r.stdout, err: r.stderr };
};
const init = (name, run, ...more) => cli(name, ['init', run, '--goal', `goal of ${run}`, '--bar', 'b', '--fence', 'f', ...more]);
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('harness: the flag beats the variable, which beats the environment; a tool marker beats its editor', () => {
  assert.equal(detect({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detect({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(detect({ CODEX_HOME: '/x' }), 'unknown', 'CODEX_HOME alone is a user setting, not Codex running');
  assert.equal(detect({ GEMINI_CLI: '1', TERM_PROGRAM: 'Antigravity' }), 'gemini');
  assert.equal(detect({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe' }), 'antigravity');
  assert.equal(detect({ ANTIGRAVITY_AGENT: '1' }), 'antigravity');
  assert.equal(detect({}), 'unknown');
  assert.equal(harnessOf(undefined, { COORDINATOR_HARNESS: 'Codex', CLAUDECODE: '1' }), 'codex');
  assert.equal(harnessOf('antigravity', { COORDINATOR_HARNESS: 'codex' }), 'antigravity');
  assert.throws(() => harnessOf('no spaces please', {}), /--harness/);
});

test('version warnings: older and newer copies warn, the same version and unstamped runs do not', () => {
  assert.equal(versionWarning('1.0.0', '1.1.1'), 'written by skill 1.0.0; this dashboard is 1.1.1');
  assert.match(versionWarning('2.0.0', '1.1.1'), /newer than this dashboard \(1\.1\.1\)/);
  assert.equal(versionWarning('1.1.1', '1.1.1'), null);
  assert.equal(versionWarning(undefined, '1.1.1'), null);
  const o = origin({ id: 'r', units: [] }, '1.1.1');
  assert.equal(o.warning, null);
  assert.match(o.line, /not recorded/);
  const o2 = origin({ startedBy: { harness: 'antigravity', skill: '1.1.0' }, writer: { harness: 'claude-code', skill: '1.0.0' }, alias: 'nick' }, '1.1.1');
  assert.equal(o2.line, 'started in Antigravity · skill 1.1.0');
  assert.equal(o2.later, 'last written in Claude Code · skill 1.0.0');
  assert.equal(o2.alias, 'nick');
  assert.match(o2.warning, /written by skill 1\.0\.0/);
});

test('init stamps the run with the tool and skill, records the alias, and registers it', () => {
  const r = init('p1', 'payday-1275-onboarding', '--alias', 'payday-onboarding-filter', '--harness', 'antigravity');
  assert.equal(r.code, 0, r.err);
  const s = loadRun(join(state('p1'), 'runs', 'payday-1275-onboarding'));
  assert.deepEqual(s.startedBy, { harness: 'antigravity', skill: VERSION });
  assert.equal(s.alias, 'payday-onboarding-filter');
  // A later write by another tool: the event carries the new writer as its last op.
  assert.equal(cli('p1', ['note', 'payday-1275-onboarding', '--kind', 'info', '--text', 'x'], { COORDINATOR_HARNESS: 'codex' }).code, 0);
  const dir = join(state('p1'), 'runs', 'payday-1275-onboarding');
  const ev = parseLog(readFileSync(join(dir, 'events.jsonl'))).events.at(-1);
  assert.deepEqual(ev.payload.ops.at(-1), { op: 'set', path: ['writer'], value: { harness: 'codex', skill: VERSION } });
  const html = readFileSync(join(dir, 'hud.html'), 'utf8');
  assert.match(html, /payday-onboarding-filter/);
  assert.match(html, /started in Antigravity · skill/);
  assert.match(html, /last written in Codex/);
  const reg = readRegistry({ home });
  const e = reg.find((x) => x.run === 'payday-1275-onboarding');
  assert.equal(e.alias, 'payday-onboarding-filter');
  assert.equal(e.harness, 'codex');
  assert.equal(e.startedIn, 'antigravity');
  assert.ok(!JSON.stringify(reg).includes('ghp_'), 'no token-shaped text');
});

test('a run written by another skill version shows a warning on its dashboard, and still loads', () => {
  const dir = join(tmp, 'old-version', 'runs', 'r9');
  updateRun(dir, { kind: 'run.init', by: { harness: 'antigravity', skill: '1.0.0' } }, () => ({ id: 'r9', tag: 'x', goal: 'g', bar: 'b', fence: 'f', paths: [], budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45, maxStudies: 2 }, createdAt: new Date().toISOString(), frozen: false, addedAfterFreeze: 0, units: [], notes: [], integration: { rounds: [] }, closed: null }));
  const s = loadRun(dir);
  const html = hud(view(s, decide(s)));
  assert.match(html, new RegExp(`written by skill 1\\.0\\.0; this dashboard is ${VERSION.replace(/\./g, '\\.')}`));
});

test('the register under concurrent writers keeps every run, and stays valid JSON', async () => {
  const h = join(tmp, 'conc-home');
  const n = 8;
  for (let i = 0; i < n; i++) mkdirSync(join(tmp, 'conc', `s${i}`, 'runs', `r${i}`), { recursive: true });
  const code = `import { register, entryFor } from ${JSON.stringify(new URL('../lib/registry.mjs', import.meta.url).href)};
    const [i, base] = process.argv.slice(1);
    for (let k = 0; k < 5; k++) register(entryFor({ id: 'r' + i, goal: 'g' + k, units: [] }, { project: base, stateDir: base + '/s' + i, stamp: { harness: 'codex', skill: '1' } }), { home: ${JSON.stringify(h)}, now: Date.now() + k * 120000 });`;
  const kids = Array.from({ length: n }, (_, i) => new Promise((ok) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, String(i), join(tmp, 'conc')], { stdio: 'inherit' });
    c.on('exit', ok);
  }));
  assert.deepEqual(await Promise.all(kids), Array(n).fill(0));
  const data = JSON.parse(readFileSync(registryFile(h), 'utf8'));
  assert.equal(data.runs.length, n);
  assert.deepEqual(data.runs.map((r) => r.run).sort(), Array.from({ length: n }, (_, i) => `r${i}`).sort());
  assert.ok(data.runs.every((r) => r.title === 'g4'), 'the last write of each wins');
});

test('pruning: a run whose folder is gone leaves the register on the next write and is skipped on read', () => {
  const h = join(tmp, 'prune-home');
  const mk = (id) => { const sd = join(tmp, 'prune', id); mkdirSync(join(sd, 'runs', id), { recursive: true }); return entryFor({ id, goal: id, units: [] }, { project: tmp, stateDir: sd, stamp: null }); };
  register(mk('a'), { home: h }); register(mk('b'), { home: h });
  rmSync(join(tmp, 'prune', 'a'), { recursive: true, force: true });
  assert.deepEqual(readRegistry({ home: h }).map((e) => e.run), ['b'], 'skipped on read');
  assert.equal(JSON.parse(readFileSync(registryFile(h), 'utf8')).runs.length, 2, 'reading alone writes nothing');
  register(mk('c'), { home: h });
  assert.deepEqual(JSON.parse(readFileSync(registryFile(h), 'utf8')).runs.map((e) => e.run).sort(), ['b', 'c']);
});

test('old runs load: a 0.1 state folder shows, and registers on its next write as "not recorded"', () => {
  const src = join(scripts, 'test', 'fixtures', 'old-runs', 'v0.1');
  cpSync(src, state('old'), { recursive: true });
  const shown = cli('old', ['show', 'old-open']);
  assert.equal(shown.code, 0, shown.err);
  assert.equal(cli('old', ['hud', 'old-closed']).code, 0);
  const all = cli('old', ['list', '--all']);
  assert.equal(all.code, 0, all.err);
  const row = all.out.flatMap((g) => g.runs).find((r) => r.run === 'old-closed');
  assert.ok(row, 'registered by hud');
  assert.match(row.origin, /not recorded/);
  assert.equal(row.warning, undefined);
});

const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

test('dashboard: serves every registered run, a second call reuses it, stop stops it', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [join(scripts, 'run.mjs'), 'dashboard', '--port', String(port)], { cwd: tmp, env: env('p1') });
  const first = await new Promise((ok, fail) => {
    let buf = ''; child.stdout.on('data', (d) => { buf += d; const m = /\{.*\}/.exec(buf); if (m) ok(JSON.parse(m[0])); });
    child.on('exit', (c) => fail(new Error(`exited ${c}`)));
  });
  try {
    assert.match(first.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?t=`));
    const page = await (await fetch(first.url)).text();
    assert.match(page, /Coordinator · this PC/);
    assert.match(page, /payday-1275-onboarding/);
    assert.match(page, /payday-onboarding-filter/);
    const link = /href="(\/p\/[0-9a-f]{12}\/run\/payday-1275-onboarding\?t=[^"]+)"/.exec(page);
    assert.ok(link, 'the run links to its read-only page');
    const runPage = await (await fetch(new URL(link[1].replace(/&amp;/g, '&'), first.url))).text();
    assert.match(runPage, /started in Antigravity/);
    assert.equal((await fetch(new URL('/p/000000000000/run/x?t=' + new URL(first.url).searchParams.get('t'), first.url))).status, 404, 'unknown project key');
    assert.equal((await fetch(new URL(link[1].replace(/\?t=.*/, ''), first.url))).status, 403, 'token required');
    const again = cli('p1', ['dashboard']);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.out.reused, true);
    assert.equal(again.out.url, first.url);
    const rec = JSON.parse(readFileSync(join(home, 'dashboard.json'), 'utf8'));
    assert.equal(rec.pid, child.pid);
    const stop = cli('p1', ['dashboard', 'stop']);
    assert.equal(stop.out.stopped, true);
    await new Promise((ok) => (child.exitCode !== null ? ok() : child.on('exit', ok)));
    assert.equal(cli('p1', ['dashboard', 'stop']).out.stopped, false);
  } finally { if (child.exitCode === null) child.kill(); }
  assert.ok(!existsSync(join(home, 'dashboard.json')) || JSON.parse(readFileSync(join(home, 'dashboard.json'), 'utf8')).pid !== child.pid);
});

test('dashboard stop leaves a process alone that does not serve the recorded link, and drops the record', async () => {
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'dashboard.json'), JSON.stringify({ pid: other.pid, port: 1, url: 'http://127.0.0.1:1/?t=x' }));
    const r = cli('p1', ['dashboard', 'stop']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.stopped, false);
    assert.match(r.out.note, /does not serve the dashboard/);
    assert.equal(other.exitCode, null);
    assert.doesNotThrow(() => process.kill(other.pid, 0), 'the other process is still alive');
    assert.ok(!existsSync(join(home, 'dashboard.json')));
  } finally { other.kill(); }
});

test('coordinator.html is never older than the last change, however close the changes come', () => {
  assert.equal(init('snap', 's1').code, 0);
  assert.equal(cli('snap', ['add', 's1', 'first-unit', '--bar', 'b']).code, 0);
  assert.equal(cli('snap', ['add', 's1', 'last-unit-in-burst', '--bar', 'b']).code, 0);
  const html = readFileSync(join(state('snap'), 'coordinator.html'), 'utf8');
  assert.match(html, /last-unit-in-burst/);
  assert.match(html, /Snapshot written/);
  assert.match(html, /\/coordinator:dashboard/);
});

test('a registered project\'s retro page reads that project\'s runs and lessons, not the served folder\'s', () => {
  const lesson = (text) => [{ id: 'L1', tag: 'process', text, seen: 1, used: 0, from: ['b1'] }];
  assert.equal(init('projA', 'b1').code, 0);
  assert.equal(init('projB', 'b1').code, 0);
  writeFileSync(join(state('projA'), 'lessons.json'), JSON.stringify(lesson('lesson-from-A')));
  writeFileSync(join(state('projB'), 'lessons.json'), JSON.stringify(lesson('lesson-from-B')));
  const entries = readRegistry({ home });
  const b = entries.find((e) => e.run === 'b1' && e.stateDir.includes('projB'));
  const before = process.env.COORDINATOR_DIR;
  process.env.COORDINATOR_DIR = state('projA'); // the folder the dashboard was started from
  try {
    const html = projectPage(`/p/${b.key}/run/b1/retro`, { token: 't', nonce: 'n' }, entries, { path: '/', label: 'This PC', href: '/?t=t' });
    assert.match(html, /lesson-from-B/);
    assert.doesNotMatch(html, /lesson-from-A/);
    assert.ok(html.includes(`/coordinator:retro b1</code> in ${basename(b.project)}`), 'the retro hint names the run’s own project');
  } finally { if (before === undefined) delete process.env.COORDINATOR_DIR; else process.env.COORDINATOR_DIR = before; }
});

test('list --all registers the current folder\'s runs from before the register, once', () => {
  const src = join(scripts, 'test', 'fixtures', 'old-runs', 'v0.2');
  cpSync(src, state('pre'), { recursive: true });
  const all = cli('pre', ['list', '--all']);
  assert.equal(all.code, 0, all.err);
  const mine = all.out.find((g) => g.here);
  assert.deepEqual(mine.runs.map((r) => r.run).sort(), ['old-closed', 'old-open']);
});

test('the register ignores entries whose run id is not a safe id', () => {
  const h = join(tmp, 'unsafe-home');
  const sd = join(tmp, 'unsafe'); mkdirSync(join(sd, 'runs', 'ok'), { recursive: true });
  mkdirSync(h, { recursive: true });
  writeFileSync(registryFile(h), JSON.stringify({ v: 1, runs: [{ run: '../..', stateDir: sd }, { run: 'ok', stateDir: sd }] }));
  assert.deepEqual(readRegistry({ home: h }).map((e) => e.run), ['ok']);
});
