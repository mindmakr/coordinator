// The local demo (src/demo): when it refuses to start, that its routes exist only in demo
// mode, and one walk through it end to end on a run folder made with the skill's own CLI:
// sign in as either pretend person, see the banner, answer, play GitHub and the lead, see
// alerts in the outbox, and never touch the network or the folder that was passed in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { demoGuard } from '../src/demo/guard.mjs';
import { startDemo, sweepStale } from '../src/demo/index.mjs';
import { copyRuns, pitStop } from '../src/demo/runs.mjs';
import { BANNER_TEXT } from '../src/demo/ui.mjs';
import { startApp } from './helpers.mjs';

const RUN_MJS = fileURLToPath(new URL('../../skills/coordinator/scripts/run.mjs', import.meta.url));
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const CLEAN = {};

// A project with one open run, made by the CLI, plus files the demo must never copy.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'coord-demo-src-'));
  const cli = (...a) => {
    const r = spawnSync(process.execPath, [RUN_MJS, ...a], { cwd: root, env: { ...process.env, COORDINATOR_DIR: join(root, '.coordinator') }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`run.mjs ${a.join(' ')}: ${r.stderr}`);
  };
  cli('init', 'r1', '--goal', 'Totals match', '--bar', 'tests pass', '--fence', 'web only', '--repo', 'acme/web');
  cli('add', 'r1', 'u1', '--bar', 'the total is right', '--title', 'Totals');
  cli('link', 'r1', 'u1', '--pr', 'acme/web#12');
  cli('freeze', 'r1');
  cli('start', 'r1', 'u1');
  cli('note', 'r1', '--kind', 'info', '--text', `deploy token ${TOKEN} found in the log`);
  const run = join(root, '.coordinator', 'runs', 'r1');
  writeFileSync(join(run, '.env'), 'SECRET=never-copy-me\n');
  mkdirSync(join(run, 'artifacts'));
  writeFileSync(join(run, 'artifacts', 'evidence.txt'), 'kept locally\n');
  return { root, run };
}

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)).map((x) => `${f}/${x}`) : [f]));
const digest = (d) => createHash('sha256').update(walk(d).sort().map((f) => `${f}:${createHash('sha256').update(readFileSync(join(d, f))).digest('hex')}`).join('\n')).digest('hex');

// Every outgoing connection and name lookup this process makes while fn runs.
async function watchNetwork(fn) {
  const seen = [];
  const connect = net.Socket.prototype.connect;
  const lookup = dns.lookup;
  net.Socket.prototype.connect = function watched(...a) {
    const o = a[0];
    seen.push(Array.isArray(o) ? String(o[0]?.host ?? o[0]?.path ?? '?') : typeof o === 'object' ? String(o.host ?? o.path ?? 'localhost') : String(a[1] ?? 'localhost'));
    return connect.apply(this, a);
  };
  dns.lookup = function watchedLookup(host, ...a) { seen.push(`dns:${host}`); return lookup.call(this, host, ...a); };
  try { await fn(); } finally { net.Socket.prototype.connect = connect; dns.lookup = lookup; }
  return seen;
}

test('the demo refuses to start off loopback, in production, or beside a real GitHub App', async () => {
  for (const host of ['127.0.0.1', '::1']) assert.doesNotThrow(() => demoGuard({ host, env: CLEAN }));
  for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.5', '']) assert.throws(() => demoGuard({ host, env: CLEAN }), /127\.0\.0\.1 or ::1 only/);
  assert.throws(() => demoGuard({ host: '127.0.0.1', env: { NODE_ENV: 'production' } }), /NODE_ENV is production/);
  assert.throws(() => demoGuard({ host: '127.0.0.1', env: { APP_ENV: ' Production ' } }), /APP_ENV is production/);
  for (const v of ['prod', 'PRD', 'live']) assert.throws(() => demoGuard({ host: '127.0.0.1', env: { APP_ENV: v } }), /APP_ENV is/);
  // Fail closed: only unset, empty or a known local name passes.
  for (const v of ['staging', 'stage', 'prodution', 'qa', 'uat', 'preview', 'development2']) assert.throws(() => demoGuard({ host: '127.0.0.1', env: { NODE_ENV: v } }), /NODE_ENV is .*runs only with it unset/);
  for (const v of ['', '  ', 'local', ' Demo ', 'TEST', 'development']) assert.doesNotThrow(() => demoGuard({ host: '127.0.0.1', env: { APP_ENV: v, NODE_ENV: v } }), v);
  assert.throws(() => demoGuard({ host: '127.0.0.1', env: { NODE_ENV: 'live' } }), /NODE_ENV is live/);
  for (const k of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET', 'SESSION_SECRET', 'DATABASE_URL']) {
    assert.throws(() => demoGuard({ host: '127.0.0.1', env: { [k]: 'x' } }), new RegExp(`${k} is set`));
  }
  assert.doesNotThrow(() => demoGuard({ host: '::1', env: { NODE_ENV: 'development', GITHUB_APP_ID: '' } }));
  // startDemo checks before it copies or listens on anything.
  await assert.rejects(startDemo({ runs: ['nowhere'], host: '0.0.0.0', env: CLEAN }), /127\.0\.0\.1 or ::1 only/);
  await assert.rejects(startDemo({ runs: ['nowhere'], env: { GITHUB_APP_ID: '1' } }), /GITHUB_APP_ID is set/);
  await assert.rejects(startDemo({ runs: [], env: CLEAN }), /at least one run folder/);
});

test('the demo routes do not exist on the real service', async () => {
  const t = await startApp();
  try {
    for (const p of ['/demo', '/demo/sign-in?state=x', '/demo/outbox']) {
      const r = await fetch(`${t.base}${p}`);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(await r.text(), new RegExp(BANNER_TEXT));
    }
    const post = await fetch(`${t.base}/demo/push`, { method: 'POST', headers: { Origin: t.cfg.baseUrl } });
    assert.equal(post.status, 404);
    // Sign-in still goes to GitHub, not to a demo picker.
    const login = await fetch(`${t.base}/login`, { redirect: 'manual' });
    assert.match(login.headers.get('location'), /^https:\/\/github\.example\/login\/oauth\/authorize/);
  } finally { await t.close(); }
});

test('the demo end to end: copies only, banner everywhere, both people, answers, GitHub and the lead, the outbox, no network', async () => {
  const src = project();
  const before = digest(src.run);
  let demo;
  const seen = await watchNetwork(async () => {
    demo = await startDemo({ runs: [src.run], env: CLEAN, log: { info() {}, warn() {}, error() {} } });
    try {
      const base = demo.url;
      assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
      // The copy: the log and snapshot, never .env or evidence files.
      const copy = demo.projects[0].runs[0].dir;
      assert.ok(existsSync(join(copy, 'events.jsonl')));
      assert.ok(!existsSync(join(copy, '.env')) && !existsSync(join(copy, 'artifacts')));
      assert.equal(demo.projects[0].repo, 'acme/web');

      const get = async (p, cookie = '') => { const r = await fetch(`${base}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' }); return { status: r.status, text: await r.text(), r }; };
      const post = (p, body, cookie = '') => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body), headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) } });
      // Sign in through the real routes, with the demo picker standing in for GitHub's page.
      async function signIn(login) {
        const start = await fetch(`${base}/login?next=/r/acme/web/run/r1`, { redirect: 'manual' });
        const oauth = start.headers.get('set-cookie').split(';')[0];
        const picker = await get(new URL(start.headers.get('location')).pathname + new URL(start.headers.get('location')).search);
        assert.match(picker.text, new RegExp(BANNER_TEXT));
        const href = new RegExp(`href="([^"]+)"[^>]*>Sign in as ${login}<`).exec(picker.text)[1].replace(/&amp;/g, '&');
        const back = await fetch(href, { headers: { Cookie: oauth }, redirect: 'manual' });
        assert.equal(back.status, 302);
        assert.equal(back.headers.get('location'), '/r/acme/web/run/r1');
        return back.headers.getSetCookie().find((c) => c.startsWith('coordinator=')).split(';')[0];
      }

      const landing = await get('/');
      assert.equal(landing.status, 200);
      assert.match(landing.text, new RegExp(BANNER_TEXT));
      assert.match(landing.text, /Demo sign in/);

      const ana = await signIn('ana');
      const home = await get('/', ana);
      assert.match(home.text, /acme\/web/);
      assert.match(home.text, new RegExp(BANNER_TEXT));
      let page = await get('/r/acme/web/run/r1', ana);
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(BANNER_TEXT));
      assert.match(page.text, /Totals match/);
      assert.doesNotMatch(page.text, new RegExp(TOKEN), 'secrets stay masked');
      assert.match(page.text, /can answer/);
      assert.match((await get('/r/acme/web/run/r1/unit/u1', ana)).text, new RegExp(BANNER_TEXT));
      assert.match((await get('/alerts', ana)).text, /go to the <a href="\/demo\/outbox">outbox/);

      // The lead asks; both people get a "needs you" alert, and the answer form appears.
      assert.equal((await post('/demo/ask', { run: 'acme/web r1' })).status, 303);
      assert.match((await get('/demo')).text, /The lead asked q1 on r1/);
      assert.ok(demo.outbox.some((x) => x.title === 'Coordinator: needs you' && x.channel === 'email' && x.to === 'ana@demo.invalid'));
      page = await get('/r/acme/web/run/r1', ana);
      assert.match(page.text, /should the lead keep going/);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)[1];
      const answered = await post('/r/acme/web/run/r1/answer', { csrf, q: 'q1', choice: 'go' }, ana);
      assert.equal(answered.status, 303);
      // The answer is on the demo's branch, and the next push takes it into the lead's copy.
      assert.match(demo.gh.repos.get('acme/web').files.get('runs/r1/events.jsonl').toString('utf8'), /"kind":"answer"/);
      assert.equal((await post('/demo/push', {})).status, 303);
      assert.match(readFileSync(join(copy, 'events.jsonl'), 'utf8'), /"kind":"answer"/);

      // GitHub: the PR is merged, then its checks fail.
      assert.equal((await post('/demo/merge', { ref: 'acme/web#12', how: 'merged' })).status, 303);
      assert.equal((await post('/demo/checks', { ref: 'acme/web#12', conclusion: 'failure' })).status, 303);
      page = await get('/r/acme/web/run/r1', ana);
      assert.match(page.text, /acme\/web#12<\/a> merged \(GitHub\)/);
      assert.match(page.text, /checks failure \(GitHub\)/);
      const outbox = await get('/demo/outbox');
      assert.match(outbox.text, new RegExp(BANNER_TEXT));
      for (const t of ['needs you', 'merged', 'checks failed']) assert.match(outbox.text, new RegExp(`Coordinator: ${t}`));

      // Ben reads, and cannot write.
      const ben = await signIn('ben');
      page = await get('/r/acme/web/run/r1', ben);
      assert.match(page.text, /read-only/);
      const refused = await post('/r/acme/web/run/r1/note', { csrf: /name="csrf" value="([^"]+)"/.exec(page.text)[1], text: 'hello' }, ben);
      assert.equal(refused.status, 403);

      // A control posted from another site is refused.
      const cross = await fetch(`${base}/demo/push`, { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example' } });
      assert.equal(cross.status, 403);
    } finally { await demo.close(); }
  });
  try {
    assert.equal(digest(src.run), before, 'the folder passed in is never written');
    assert.ok(!existsSync(demo.tmp), 'the copies are deleted on close');
    const outside = seen.filter((h) => !['127.0.0.1', '::1'].includes(h.replace(/^dns:/, '')));
    assert.deepEqual(outside, [], 'no connection or lookup leaves the machine');
    assert.ok(seen.includes('127.0.0.1'), 'the watch saw the local requests');
  } finally { rmSync(src.root, { recursive: true, force: true }); }
});

const quiet = { info() {}, warn() {}, error() {} };

test('every push, merge and check reaches the service: the lead asks twice and both questions show and alert', async () => {
  const src = project();
  const demo = await startDemo({ runs: [src.run], env: CLEAN, log: quiet });
  try {
    const base = demo.url;
    const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body), headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const flash = async () => /<div class="goal"><p>([^<]*)<\/p>/.exec(await (await fetch(`${base}/demo`)).text())?.[1] ?? '';
    for (const q of ['q1', 'q2']) {
      assert.equal((await post('/demo/ask', { run: 'acme/web r1' })).status, 303);
      const said = await flash();
      assert.match(said, new RegExp(`asked ${q}`));
      assert.doesNotMatch(said, /duplicate/);
      // A plain push after the question changes nothing on the branch, but is still delivered.
      assert.equal((await post('/demo/push', {})).status, 303);
      assert.doesNotMatch(await flash(), /duplicate/);
    }
    // Both questions are on the run page.
    const start = await fetch(`${base}/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const back = await fetch(`${base}/auth/callback?code=ana&state=${state}`, { headers: { Cookie: start.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
    const cookie = back.headers.getSetCookie().find((c) => c.startsWith('coordinator=')).split(';')[0];
    const page = await (await fetch(`${base}/r/acme/web/run/r1`, { headers: { Cookie: cookie } })).text();
    for (const q of ['q1', 'q2']) assert.match(page, new RegExp(`id="${q}"`));
    const needs = demo.outbox.filter((x) => x.title === 'Coordinator: needs you' && x.channel === 'email' && x.to === 'ana@demo.invalid');
    assert.equal(needs.length, 2, 'one alert per question');
    for (let i = 0; i < 2; i++) {
      assert.equal((await post('/demo/merge', { ref: 'acme/web#12', how: 'closed' })).status, 303);
      assert.doesNotMatch(await flash(), /duplicate/);
      assert.equal((await post('/demo/checks', { ref: 'acme/web#12', conclusion: 'success' })).status, 303);
      assert.doesNotMatch(await flash(), /duplicate/);
    }
  } finally { await demo.close(); rmSync(src.root, { recursive: true, force: true }); }
});

test('copies: logs over the cap are left out and listed, the pit stop never asks GitHub, stale copies are swept', async () => {
  const src = project();
  try {
    // A temp folder inside the project: without the copy's "visibility" the pit stop would ask `gh repo view`.
    const inside = mkdtempSync(join(src.root, 'tmp-'));
    const { projects, skipped } = copyRuns([src.run], inside);
    assert.deepEqual(skipped, []);
    assert.match(readFileSync(join(projects[0].base, 'coordinator.json'), 'utf8'), /"visibility": "private"/);
    assert.ok(pitStop(projects[0], projects[0].runs[0]).pushed);

    const big = join(src.root, '.coordinator', 'runs', 'huge');
    mkdirSync(big);
    writeFileSync(join(big, 'events.jsonl'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const two = copyRuns([src.run, big], mkdtempSync(join(tmpdir(), 'coord-demo-cap-')));
    assert.deepEqual(two.projects[0].runs.map((r) => r.id), ['r1']);
    assert.match(two.skipped[0], /^huge: its log is 8\.0 MB, over the service's 8 MB cap/);
    await assert.rejects(startDemo({ runs: [big], env: CLEAN, log: quiet }), /no run could be loaded: huge/);
    rmSync(two.projects[0].root, { recursive: true, force: true });

    // Stale copies: only a folder whose recorded pid has exited goes.
    const root = mkdtempSync(join(tmpdir(), 'coord-demo-sweep-'));
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    for (const [name, pid] of [['coordinator-demo-dead', dead], ['coordinator-demo-alive', process.ppid], ['coordinator-demo-nopid', null], ['other-dead', dead]]) {
      mkdirSync(join(root, name));
      if (pid) writeFileSync(join(root, name, 'pid'), `${pid}\n`);
    }
    assert.deepEqual(sweepStale(root), ['coordinator-demo-dead']);
    assert.deepEqual(readdirSync(root).sort(), ['coordinator-demo-alive', 'coordinator-demo-nopid', 'other-dead']);
    rmSync(root, { recursive: true, force: true });
  } finally { rmSync(src.root, { recursive: true, force: true }); }
});
