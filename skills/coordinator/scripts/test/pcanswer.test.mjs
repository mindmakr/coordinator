// The PC dashboard (design one-boss 5.4): it runs detached and outlives the process that started it,
// and its front page's Needs you takes answers for every registered run, written by `run.mjs answer`
// in that project's state folder, with the page's token and origin required and nothing written on a refusal.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { needsSection, pcModel } from '../lib/dashboard.mjs';
import { loadRun } from '../lib/events.mjs';
import { dashboardCaller, pcAnswer, VIA_ENV } from '../lib/pcanswer.mjs';
import { readRegistry } from '../lib/registry.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coord-pcans-'));
const home = join(tmp, 'home');
const state = (name) => join(tmp, name, '.coordinator');
const env = (name, extra = {}) => ({ ...process.env, COORDINATOR_DIR: state(name), COORDINATOR_HOME: home, COORDINATOR_REGISTRY: 'on', COORDINATOR_HARNESS: '', ...extra });
const cli = (name, args, extra) => {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: tmp, env: env(name, extra), encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out, raw: r.stdout, err: r.stderr };
};
const setup = (name, run, header) => {
  assert.equal(cli(name, ['init', run, '--goal', `goal of ${run}`, '--bar', 'b', '--fence', 'f', '--alias', `${name} work`]).code, 0);
  assert.equal(cli(name, ['add', run, 'u1', '--bar', 'b', '--title', 'Mobile card']).code, 0);
  const asked = cli(name, ['ask', run, '--question', `Ship ${name}?`, '--header', header, '--option', 'Yes|ship it', '--option', 'No|wait', '--unit', 'u1']);
  assert.equal(asked.code, 0, asked.err);
  return asked.out.asked;
};
const qOf = (name, run, id) => loadRun(join(state(name), 'runs', run)).notes.filter((n) => n.kind === 'question')[Number(id.slice(1)) - 1];
const eventsSize = (name, run) => readFileSync(join(state(name), 'runs', run, 'events.jsonl'), 'utf8').length;
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
test.after(() => {
  // Never leave a dashboard behind: stop the one this file started, if it is still up.
  try { const rec = JSON.parse(readFileSync(join(home, 'dashboard.json'), 'utf8')); if (alive(rec.pid)) process.kill(rec.pid); } catch { /* none */ }
  rmSync(tmp, { recursive: true, force: true });
});

test('pcAnswer: builds the run.mjs answer arguments for an open question, and refuses everything else', () => {
  const qa = setup('alpha', 'ra', 'Ship');
  const entries = readRegistry({ home });
  const e = entries.find((x) => x.run === 'ra');
  const form = (o) => { const f = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [].concat(v)) f.append(k, x); return f; };
  const ok = pcAnswer(entries, form({ key: e.key, run: 'ra', q: qa, choice: 'Yes' }));
  assert.deepEqual(ok.args, ['answer', 'ra', qa, '--choice=Yes', '--by', 'person']);
  assert.equal(ok.entry.stateDir, e.stateDir, 'the state folder comes from the register');
  assert.equal(ok.anchor, `needs-${e.key}-ra`);
  // Free text that looks like a flag stays the value of --other.
  assert.deepEqual(pcAnswer(entries, form({ key: e.key, run: 'ra', q: qa, choice: '__other', other: '--by lead' })).args, ['answer', 'ra', qa, '--other=--by lead', '--by', 'person']);
  const refused = (o, re) => assert.throws(() => pcAnswer(entries, form(o)), re);
  refused({ key: '000000000000', run: 'ra', q: qa, choice: 'Yes' }, /not in the register/);
  refused({ key: e.key.toUpperCase(), run: 'ra', q: qa, choice: 'Yes' }, /not in the register/);
  refused({ key: e.key, run: '../alpha', q: qa, choice: 'Yes' }, /not in the register/);
  refused({ key: e.key, run: 'nope', q: qa, choice: 'Yes' }, /not in the register/);
  refused({ key: [e.key, e.key], run: 'ra', q: qa, choice: 'Yes' }, /not in the register/);
  refused({ key: e.key, run: 'ra', q: 'q9', choice: 'Yes' }, /no question q9/);
  refused({ key: e.key, run: 'ra', q: '../q1', choice: 'Yes' }, /no question/);
  refused({ key: e.key, run: 'ra', q: qa, choice: 'Maybe' }, /has no option "Maybe"/);
  refused({ key: e.key, run: 'ra', q: qa }, /give an answer/);
  refused({ key: e.key, run: 'ra', q: qa, choice: '__other', other: '   ' }, /give an answer/);
  refused({ key: e.key, run: 'ra', q: qa, choice: '__other', other: 'x'.repeat(1001) }, /1000 characters/);
  // Not open: answered (waiting for the lead) or closed run.
  assert.equal(cli('alpha', ['answer', 'ra', qa, '--choice', 'No', '--by', 'lead']).code, 0);
  refused({ key: e.key, run: 'ra', q: qa, choice: 'Yes' }, /is not open \(answered\)/);
});

test('dashboardCaller: only a child of the recorded dashboard pid, handed its token', () => {
  const rec = { pid: 4242, url: 'http://127.0.0.1:7480/?t=abc_DEF-123' };
  assert.equal(dashboardCaller('abc_DEF-123', rec, 4242), true);
  assert.equal(dashboardCaller('abc_DEF-123', rec, 4243), false, 'another parent');
  assert.equal(dashboardCaller('abc_DEF-124', rec, 4242), false, 'another token');
  assert.equal(dashboardCaller('', rec, 4242), false);
  assert.equal(dashboardCaller('abc_DEF-12é', rec, 4242), false, 'same length in characters, not in bytes');
  assert.equal(dashboardCaller('abc_DEF-123', null, 4242), false, 'no record');
  assert.equal(dashboardCaller('abc_DEF-123', { pid: 4242, url: 'not a url' }, 4242), false);
});

test('Needs you: every open question of every registered run, labelled, each with its own answer form', () => {
  setup('beta', 'rb', 'Merge');
  const pc = pcModel(readRegistry({ home }));
  const html = needsSection(pc, { answerForm: { token: 'tok' }, pcHref: (k, r) => `/p/${k}/run/${r}?t=tok` });
  assert.match(html, /beta · beta work \(rb\) › Task u1: Mobile card/, 'the question label (project, run, task)');
  assert.match(html, /Ship beta\?/);
  const b = pc.groups.flatMap((g) => g.runs).find((r) => r.run === 'rb');
  assert.ok(html.includes(`<input type="hidden" name="key" value="${b.key}">`) && html.includes('<input type="hidden" name="run" value="rb">'), 'the form names the project by key and the run');
  assert.ok(html.includes('<input type="hidden" name="t" value="tok">'));
  assert.doesNotMatch(html, /name="(stateDir|path|dir)"/, 'no folder in the form');
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids unique across runs');
  assert.match(needsSection({ groups: [] }, {}), /Nothing needs you on this PC/);
  assert.doesNotMatch(needsSection(pc, {}), /<form/, 'no form without the dashboard\'s answer form');
});

test('B1-B3: run.mjs dashboard runs detached, takes answers for two projects, refuses bad posts, and stops', async () => {
  const qg = setup('gamma', 'rg', 'Gamma');
  const qd = setup('delta', 'rd', 'Delta');
  const port = await freePort();
  // The starting process exits once the link answers; the dashboard keeps serving.
  const started = cli('gamma', ['dashboard', '--port', String(port)]);
  assert.equal(started.code, 0, started.err);
  const { url, pid, log } = started.out;
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?t=`));
  assert.equal(log, join(home, 'dashboard.log'));
  try {
    assert.ok(alive(pid), 'the dashboard outlives the command that started it');
    assert.equal(JSON.parse(readFileSync(join(home, 'dashboard.json'), 'utf8')).pid, pid);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /\?t=/, 'the log holds no token');
    const again = cli('delta', ['dashboard']);
    assert.equal(again.out.reused, true);
    assert.equal(again.out.url, url);

    const page = await (await fetch(url)).text();
    assert.match(page, /<h2 id="pc-needs"[^>]*>Needs you<\/h2>/);
    assert.match(page, /gamma · gamma work \(rg\) › Task u1: Mobile card/);
    assert.match(page, /delta · delta work \(rd\) › Task u1: Mobile card/);
    const entries = readRegistry({ home });
    const key = (run) => entries.find((e) => e.run === run).key;
    const token = new URL(url).searchParams.get('t');
    const origin = `http://127.0.0.1:${port}`;
    const post = (fields, { headers = {}, t = token } = {}) => {
      const body = new URLSearchParams(t === null ? fields : { t, ...fields });
      return fetch(new URL('/answer', url), { method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...headers } });
    };

    // The lead's watch on delta hears the answer given on the PC page.
    const watch = spawn(process.execPath, [join(scripts, 'run.mjs'), 'watch', 'rd'], { cwd: tmp, env: env('delta') });
    let heard = ''; watch.stdout.on('data', (d) => { heard += d; });
    try {
      // B3: refused, nothing written.
      const before = [eventsSize('gamma', 'rg'), eventsSize('delta', 'rd')];
      const refusals = [
        [await post({ key: key('rg'), run: 'rg', q: qg, choice: 'Yes' }, { t: null }), 403, 'no token'],
        [await post({ key: key('rg'), run: 'rg', q: qg, choice: 'Yes' }, { t: 'wrong' }), 403, 'wrong token'],
        [await post({ key: key('rg'), run: 'rg', q: qg, choice: 'Yes' }, { headers: { Origin: 'http://evil.example' } }), 403, 'another origin'],
        [await post({ key: '0123456789ab', run: 'rg', q: qg, choice: 'Yes' }), 400, 'key not in the register'],
        [await post({ key: key('rg'), run: 'rd', q: qd, choice: 'Yes' }), 400, 'run not in that project'],
        [await post({ key: key('rg'), run: 'rg', q: 'q7', choice: 'Yes' }), 400, 'no such question'],
        [await post({ key: key('rg'), run: 'rg', q: qg, choice: 'Perhaps' }), 400, 'not an option'],
        [await post({ key: key('rg'), run: '..', q: qg, choice: 'Yes', stateDir: state('delta') }), 400, 'a path from the request'],
      ];
      for (const [res, status, why] of refusals) assert.equal(res.status, status, why);
      assert.deepEqual([eventsSize('gamma', 'rg'), eventsSize('delta', 'rd')], before, 'a refused post writes nothing');

      // B2: one answer in each project, by person, via the dashboard, through run.mjs answer.
      const g = await post({ key: key('rg'), run: 'rg', q: qg, choice: 'Yes' });
      assert.equal(g.status, 303, await g.text());
      assert.match(g.headers.get('location'), new RegExp(`#needs-${key('rg')}-rg$`));
      const d = await post({ key: key('rd'), run: 'rd', q: qd, choice: '__other', other: 'after the demo' });
      assert.equal(d.status, 303);
      const ag = qOf('gamma', 'rg', qg).history.at(-1);
      assert.deepEqual([ag.choices, ag.by, ag.via], [['Yes'], 'person', 'dashboard']);
      const ad = qOf('delta', 'rd', qd).history.at(-1);
      assert.deepEqual([ad.other, ad.by, ad.via], ['after the demo', 'person', 'dashboard']);
      // Answered now, so no longer open: a second answer from the PC page is refused.
      assert.equal((await post({ key: key('rg'), run: 'rg', q: qg, choice: 'No' })).status, 400);
      assert.deepEqual(qOf('gamma', 'rg', qg).history.length, 1);
      for (let i = 0; i < 50 && !/answer q\d+ \(u1\) by person: "after the demo"/.test(heard); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(heard, /answer q\d+ \(u1\) by person: "after the demo"/, 'the run\'s watch hears it');
      const after = await (await fetch(url)).text();
      assert.doesNotMatch(after, /Ship gamma\?|Ship delta\?/, 'answered questions leave Needs you');
    } finally { watch.kill(); }

    // A run.mjs answer that claims the dashboard but was not started by it is refused.
    const forged = cli('gamma', ['answer', 'rg', setup('gamma', 'rg2', 'Again'), '--choice', 'Yes', '--by', 'person'], { [VIA_ENV]: token });
    assert.equal(forged.code, 1);
    assert.match(forged.err, /not started by the running PC dashboard/);
  } finally {
    const stop = cli('gamma', ['dashboard', 'stop']);
    assert.equal(stop.out.stopped, true, stop.raw + stop.err);
  }
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, 'stop stops it');
  assert.ok(!existsSync(join(home, 'dashboard.json')));
});
