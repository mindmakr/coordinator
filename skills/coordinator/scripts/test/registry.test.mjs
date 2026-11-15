// The machine-wide run register, the harness and version stamp, and the global dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, harnessOf, origin, versionWarning } from '../lib/harness.mjs';
import { entryFor, inTemp, readRegistry, register, registryFile, skipRoots, tempRoots } from '../lib/registry.mjs';
import { loadRun, updateRun, parseLog } from '../lib/events.mjs';
import { decide } from '../lib/rules.mjs';
import { view } from '../lib/view.mjs';
import { hud } from '../lib/hud.mjs';
import { VERSION } from '../lib/version.mjs';
import { pcModel, pcPage, pcSection, projectPage } from '../lib/dashboard.mjs';
import { ageText } from '../lib/age.mjs';

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
  const child = spawn(process.execPath, [join(scripts, 'run.mjs'), 'dashboard', '--foreground', '--port', String(port)], { cwd: tmp, env: env('p1') });
  const first = await new Promise((ok, fail) => {
    let buf = ''; child.stdout.on('data', (d) => { buf += d; const m = /\{.*\}/.exec(buf); if (m) ok(JSON.parse(m[0])); });
    child.on('exit', (c) => fail(new Error(`exited ${c}`)));
  });
  try {
    assert.match(first.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?t=`));
    const page = await (await fetch(first.url)).text();
    assert.match(page, /<div class="head"><h1>This PC<\/h1>/);
    assert.match(page, /payday-1275-onboarding/);
    // The tabs: This PC (here) and Coordinator, a registered project's coordinator page, served read-only.
    const tab = /<nav class="tabs" aria-label="Pages"><a href="\/\?t=[^"]+" aria-current="page">This PC<\/a><a href="(\/p\/[0-9a-f]{12}\/coordinator\?t=[^"]+)">Coordinator<\/a><\/nav>/.exec(page);
    assert.ok(tab, 'tabs This PC and Coordinator');
    const coord = await fetch(new URL(tab[1].replace(/&amp;/g, '&'), first.url));
    assert.equal(coord.status, 200);
    const coordPage = await coord.text();
    assert.match(coordPage, /<div class="head"><h1>Coordinator<\/h1>/);
    assert.match(coordPage, /<a href="\/\?t=[^"]+">This PC<\/a><a href="\/p\/[0-9a-f]{12}\/coordinator\?t=[^"]+" aria-current="page">Coordinator<\/a>/);
    assert.match(coordPage, /data-path="\/p\/[0-9a-f]{12}\/coordinator"/, 'the live page refreshes this path');
    assert.match(coordPage, /href="\/p\/[0-9a-f]{12}\/run\/payday-[^"?]+\?t=/, 'its runs link to their read-only pages');
    assert.equal((await fetch(new URL(`/p/000000000000/coordinator?t=${new URL(first.url).searchParams.get('t')}`, first.url))).status, 404, 'unknown project key');
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

test('ageText: minutes, hours and days in plain words', () => {
  const m = 60_000;
  assert.equal(ageText(0), 'under a minute');
  assert.equal(ageText(59_000), 'under a minute');
  assert.equal(ageText(-5 * m), 'under a minute', 'a clock a little ahead never shows a negative age');
  assert.equal(ageText(17 * m), '17 min');
  assert.equal(ageText(60 * m), '1 h');
  assert.equal(ageText(131 * m), '2 h 11 min');
  assert.equal(ageText(24 * 60 * m), '1 d');
  assert.equal(ageText(26 * 60 * m + 30 * m), '1 d 2 h');
});

test('run cards on This PC show when the run started, when it ended or should end, and its age', () => {
  assert.equal(init('cards', 'live1').code, 0);
  assert.equal(init('cards', 'over1').code, 0);
  const closed = cli('cards', ['close', 'over1', '--outcome', 'stopped', '--reason', 'test']);
  assert.equal(closed.code, 0, closed.err);
  const at = (run) => loadRun(join(state('cards'), 'runs', run));
  const start = at('live1').createdAt; const end = at('over1').closed.at;
  const nowMs = Date.parse(start) + 3 * 3600_000;
  const pc = pcModel(readRegistry({ home }).filter((e) => ['live1', 'over1'].includes(e.run)), { nowMs });
  const card = (html, run) => html.split('<tr>').find((tr) => tr.includes(`>${run}<`));
  const html = pcSection({ pc }, {});
  const live = card(html, 'live1'); const over = card(html, 'over1');
  assert.ok(live.includes(`<time datetime="${start}" class="abs"`), 'the start, as a clock time the page localises');
  assert.match(live, /ending: no estimate yet/, 'no estimate yet is said, not left out');
  assert.match(live, /age <time datetime="[^"]+" class="age" title="[^"]+ UTC">3 h<\/time>/, 'the age, from the start to now');
  assert.ok(over.includes(`ended <time datetime="${end}" class="abs"`), 'a finished run says when it ended');
  assert.match(over, /\(took (under a minute|\d+ min)\)/, 'and how long it took');
  assert.doesNotMatch(over, /ending/);
  // A running run with an estimate says when it should end.
  const readyAt = new Date(nowMs + 25 * 60_000).toISOString();
  for (const g of pc.groups) for (const r of g.runs) if (r.run === 'live1') r.status = { ...r.status, eta: { ...r.status.eta, readyAt, short: 'about 25 min' } };
  assert.ok(card(pcSection({ pc }, {}), 'live1').includes(`ending about <time datetime="${readyAt}" class="abs"`));
  // The live page keeps the age current, and shows start and end as clock times, not "3 hours ago".
  const served = pcPage(pc, nowMs, { live: { token: 't', nonce: 'n' } });
  assert.match(served, /const ageText = /);
  assert.match(served, /classList\.contains\('age'\)/);
  assert.match(served, /classList\.contains\('abs'\)/);
});

test('This PC page: tabs, KPI row, the six panels in a main and side column, and every run, unit and question linked', () => {
  assert.equal(init('pcpage', 'pa1').code, 0);
  assert.equal(cli('pcpage', ['add', 'pa1', 'u1', '--bar', 'b', '--title', 'Base']).code, 0);
  assert.equal(cli('pcpage', ['add', 'pa1', 'u2', '--bar', 'b', '--after', 'u1', '--title', 'Totals']).code, 0);
  assert.equal(cli('pcpage', ['ask', 'pa1', '--question', 'Ship it?', '--header', 'Ship', '--option', 'Yes|now', '--option', 'No|later']).code, 0);
  assert.equal(init('pcpage', 'pa2').code, 0);
  assert.equal(cli('pcpage', ['close', 'pa2', '--outcome', 'stopped', '--reason', 'test']).code, 0);
  const nowMs = Date.now();
  const pc = pcModel(readRegistry({ home }).filter((e) => ['pa1', 'pa2'].includes(e.run)), { nowMs });
  const key = pc.groups[0].key;
  const ctx = { live: { token: 'tok', nonce: 'n' }, pages: [{ path: '/', label: 'This PC', href: '/?t=tok' }], answerForm: { token: 'tok' }, pcHref: (k, r, sub = '') => `/p/${k}/run/${r}${sub}?t=tok` };
  const html = pcPage(pc, nowMs, ctx, []);
  assert.match(html, /<nav class="tabs" aria-label="Pages"><a href="\/\?t=tok" aria-current="page">This PC<\/a><a href="\/p\/[0-9a-f]{12}\/coordinator\?t=tok">Coordinator<\/a><\/nav>/);
  const k = [...html.matchAll(/<span class="k">([^<]+)<\/span><span class="v">([^<]+)<\/span>/g)].map((x) => `${x[1]} ${x[2]}`);
  assert.deepEqual(k.slice(0, 4), ['Active 1', 'Questions 1', 'Finished today 1', 'Loose ends 0']);
  const main = html.slice(html.indexOf('<div class="main">'), html.indexOf('<div class="side">'));
  const side = html.slice(html.indexOf('<div class="side">'));
  const titles = (h) => [...h.matchAll(/<details class="panel[^"]*" data-d="([^"]+)"[^>]*?( open)?><summary>.*?<h2>([^<]+)<\/h2>/g)].map((x) => `${x[3]}${x[2] ? '' : ' (closed)'}`);
  assert.deepEqual(titles(main), ['Questions', 'Runs', 'Blocked units']);
  assert.deepEqual(titles(side), ['Loose ends', 'Coordinator', 'Concluded (closed)']);
  assert.ok(main.includes('<form'), 'the answer form is in Questions');
  assert.ok(main.includes(`href="/p/${key}/run/pa1?t=tok"`), 'the run links to its page');
  assert.ok(main.includes(`href="/p/${key}/run/pa1/unit/u2?t=tok"`), 'the blocked unit links to its page');
  assert.match(main, />after u1<\/span>/);
  assert.ok(side.includes(`href="/p/${key}/run/pa2?t=tok"`), 'a concluded run links to its page');
  assert.ok(side.includes(`href="/p/${key}/coordinator?t=tok"`), 'the Coordinator panel opens the project\'s coordinator page');
});

test('This PC page: a goal, a concluded reason and the Current column link their PRs, issues and units', () => {
  const goal = 'Fix acme/shop#12, PR https://github.com/acme/shop/pull/13';
  assert.equal(cli('pclinks', ['init', 'pl1', '--goal', goal, '--bar', 'b', '--fence', 'f']).code, 0);
  assert.equal(cli('pclinks', ['add', 'pl1', 'u1', '--bar', 'b']).code, 0);
  assert.equal(cli('pclinks', ['freeze', 'pl1']).code, 0);
  assert.equal(cli('pclinks', ['start', 'pl1', 'u1']).code, 0);
  assert.equal(cli('pclinks', ['init', 'pl2', '--goal', 'g', '--bar', 'b', '--fence', 'f']).code, 0);
  assert.equal(cli('pclinks', ['close', 'pl2', '--outcome', 'stopped', '--reason', 'see acme/shop#14']).code, 0);
  const nowMs = Date.now();
  const pc = pcModel(readRegistry({ home }).filter((e) => ['pl1', 'pl2'].includes(e.run)), { nowMs });
  const key = pc.groups[0].key;
  const ctx = { live: { token: 'tok', nonce: 'n' }, pages: [{ path: '/', label: 'This PC', href: '/?t=tok' }], answerForm: { token: 'tok' }, pcHref: (k, r, sub = '') => `/p/${k}/run/${r}${sub}?t=tok` };
  const html = pcPage(pc, nowMs, ctx, []);
  const a = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  assert.ok(html.includes(a('https://github.com/acme/shop/issues/12', 'acme/shop#12')), 'the issue in the goal');
  assert.ok(html.includes(a('https://github.com/acme/shop/pull/13', 'https://github.com/acme/shop/pull/13')), 'the PR URL in the goal');
  assert.ok(html.includes(a('https://github.com/acme/shop/issues/14', 'acme/shop#14')), 'the issue in a concluded reason');
  assert.ok(html.includes(`building <a class="ulink" href="/p/${key}/run/pl1/unit/u1?t=tok">u1</a> round 1`), 'Current links its unit');
});

// Design 5.7: runs whose state folder is in the system temporary folder stay off the PC list.
// Every state folder in this file is under tmpdir(); COORDINATOR_REGISTRY '' is the person's default.
const real = { COORDINATOR_REGISTRY: '' };
const ids = (h) => (existsSync(registryFile(h)) ? JSON.parse(readFileSync(registryFile(h), 'utf8')).runs.map((e) => e.run) : []);

test('temp folder: the folder itself and inside it count, any case on Windows, any trailing separator, never a root', () => {
  const t = join(tmp, 'sys-tmp');
  const roots = tempRoots(t + sep);
  assert.equal(inTemp(t, roots), true, 'the temporary folder itself');
  assert.equal(inTemp(join(t, 'tmp.AbC', '.coordinator'), roots), true, 'inside it');
  assert.equal(inTemp(t + sep, roots), true, 'with a trailing separator');
  assert.equal(inTemp(join(tmp, 'sys-tmp-other', '.coordinator'), roots), false, 'a sibling that only shares the prefix');
  assert.equal(inTemp(join(tmp, 'elsewhere'), roots), false);
  if (process.platform === 'win32') assert.equal(inTemp(join(t, 'X').toUpperCase(), roots), true, 'case-insensitive on Windows');
  assert.deepEqual(tempRoots(parse(tmp).root), [], 'a drive or filesystem root is never the temporary folder');
  assert.deepEqual(skipRoots({ COORDINATOR_REGISTRY: 'on' }), [], 'on records temporary runs');
  assert.deepEqual(skipRoots({}), tempRoots(), 'by default the system temporary folder is left out');
  assert.equal(inTemp(state('any'), skipRoots({})), true, "this file's state folders are temporary");
});

test('temp folder: a Windows 8.3 short spelling of a folder inside it counts', { skip: process.platform !== 'win32' }, (t) => {
  const tdir = join(tmp, 'sys tmp long name'); const run = join(tdir, 'a long run folder name'); mkdirSync(run, { recursive: true });
  const short = (p) => execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
  const [st, sr] = [short(tdir), short(run)];
  if (st.toLowerCase() === tdir.toLowerCase()) { t.skip('8.3 names are off on this volume'); return; }
  assert.equal(inTemp(sr, tempRoots(tdir)), true, 'short run folder, long temporary folder');
  assert.equal(inTemp(run, tempRoots(st)), true, 'long run folder, short temporary folder');
});

test('B1: a run.mjs write in a temporary state folder never reaches the register, unless COORDINATOR_REGISTRY=on', () => {
  const h = join(tmp, 'b1-home');
  const e = (x) => ({ COORDINATOR_HOME: h, ...x });
  assert.equal(cli('b1', ['init', 'trial-q1', '--goal', 'g', '--bar', 'b', '--fence', 'f'], e(real)).code, 0);
  assert.equal(cli('b1', ['add', 'trial-q1', 'u1', '--bar', 'b'], e(real)).code, 0);
  assert.equal(cli('b1', ['hud', 'trial-q1'], e(real)).code, 0);
  assert.equal(cli('b1', ['list', '--all'], e(real)).code, 0, "list --all registers the folder's old runs: not these");
  assert.deepEqual(ids(h), [], 'no entry written');
  // The pure function, with a fake temporary folder: inside is refused, outside recorded.
  const fake = tempRoots(join(tmp, 'b1-fake-tmp'));
  const mk = (sd) => entryFor({ id: 'r', goal: 'g', units: [] }, { project: sd, stateDir: sd });
  assert.equal(register(mk(join(tmp, 'b1-fake-tmp', 'p', '.coordinator')), { home: join(tmp, 'b1-pure'), skip: fake }), false);
  assert.equal(existsSync(registryFile(join(tmp, 'b1-pure'))), false);
  assert.equal(register(mk(join(tmp, 'b1-real', '.coordinator')), { home: join(tmp, 'b1-pure'), skip: fake }), true);
  // on: recorded.
  assert.equal(cli('b1', ['note', 'trial-q1', '--kind', 'info', '--text', 'x'], e({ COORDINATOR_REGISTRY: 'on' })).code, 0);
  assert.deepEqual(ids(h), ['trial-q1']);
});

test('B2: register entries for temporary state folders are not shown by readRegistry, This PC, the PC dashboard or list --all', async () => {
  const h = join(tmp, 'b2-home'); mkdirSync(h, { recursive: true });
  const on = { COORDINATOR_HOME: h, COORDINATOR_REGISTRY: 'on' }; const off = { COORDINATOR_HOME: h, ...real };
  assert.equal(cli('b2old', ['init', 'old-q5', '--goal', 'g', '--bar', 'b', '--fence', 'f'], on).code, 0, 'an entry from before the fix');
  assert.deepEqual(ids(h), ['old-q5']);
  // readRegistry: hidden by default, shown with on; reading writes nothing.
  assert.deepEqual(readRegistry({ home: h, skip: [] }).map((e) => e.run), ['old-q5']);
  assert.deepEqual(readRegistry({ home: h, skip: skipRoots({}) }), []);
  assert.deepEqual(ids(h), ['old-q5'], 'a read without prune leaves the file alone');
  // With a fake temporary folder, an entry outside it still shows.
  assert.deepEqual(readRegistry({ home: h, skip: tempRoots(join(tmp, 'b2-fake-tmp')) }).map((e) => e.run), ['old-q5']);
  // This PC on the coordinator page (coordinator.html, rewritten on every write).
  assert.equal(cli('b2new', ['init', 'new-run', '--goal', 'g', '--bar', 'b', '--fence', 'f'], on).code, 0);
  assert.match(readFileSync(join(state('b2new'), 'coordinator.html'), 'utf8'), /old-q5/, 'shown with on');
  assert.equal(cli('b2new', ['note', 'new-run', '--kind', 'info', '--text', 'x'], off).code, 0);
  assert.doesNotMatch(readFileSync(join(state('b2new'), 'coordinator.html'), 'utf8'), /old-q5/, 'hidden by default');
  // The PC dashboard.
  const port = await freePort();
  const child = spawn(process.execPath, [join(scripts, 'run.mjs'), 'dashboard', '--foreground', '--port', String(port)], { cwd: tmp, env: env('b2new', off) });
  try {
    const first = await new Promise((ok, fail) => {
      let buf = ''; child.stdout.on('data', (d) => { buf += d; const m = /\{.*\}/.exec(buf); if (m) ok(JSON.parse(m[0])); });
      child.on('exit', (c) => fail(new Error(`exited ${c}`)));
    });
    const page = await (await fetch(first.url)).text();
    assert.match(page, /<h1>This PC<\/h1>/);
    assert.doesNotMatch(page, /old-q5|new-run/);
  } finally { child.kill(); }
  // list --all: hidden, and pruned from the file.
  const all = cli('b2new', ['list', '--all'], off);
  assert.equal(all.code, 0, all.err);
  assert.deepEqual(all.out, []);
  assert.deepEqual(ids(h), [], 'list --all prunes them');
});
