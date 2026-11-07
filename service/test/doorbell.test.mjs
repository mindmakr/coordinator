import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { listen, sseParser } from '../../skills/coordinator/scripts/lib/doorbell.mjs';
import { appendEvent, makeRun, startApp, stateFiles } from './helpers.mjs';

const INST = 7; const REPO = 70;

async function setup(over = {}) {
  const t = await startApp(over);
  t.runs = { r1: makeRun('r1'), r2: makeRun('r2') };
  t.gh.addRepo('acme/web', { id: REPO, installationId: INST, files: stateFiles(t.runs) });
  t.gh.addRepo('acme/other', { id: 71, installationId: INST, files: null });
  t.gh.addUser('tok-ana', { id: 5, login: 'ana', read: ['acme/web'] });
  t.gh.addUser('tok-bob', { id: 6, login: 'bob', read: [] });
  await t.db.upsertInstallation({ id: INST, account: 'acme' });
  await t.app.ingest.syncInstallation(INST);
  await t.app.idle();
  // A change to run `id` on the state branch, as a push would bring.
  t.change = async (id) => {
    t.runs[id] = appendEvent(t.runs[id], 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'person', text: 'hi', unit: null, at: new Date().toISOString() }] }] });
    t.gh.setFiles('acme/web', stateFiles(t.runs));
    await t.app.ingest.syncRepo(INST, { id: REPO, fullName: 'acme/web' });
  };
  return t;
}

const mint = (t, token, repo = 'acme/web') => fetch(`${t.base}/doorbell/token?repo=${encodeURIComponent(repo)}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

// Opens the stream; events land in .events as [event, data].
function stream(t, token, run) {
  return new Promise((ok, fail) => {
    const events = [];
    const req = request(`${t.base}/doorbell${run ? `?run=${run}` : ''}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', sseParser((e, d) => events.push([e, JSON.parse(d)])));
      ok({ res, events, close: () => req.destroy() });
    });
    req.on('error', fail);
    req.end();
  });
}
// Waits for a condition. The limit only stops a broken test from hanging; no test asserts a time.
const until = async (fn, ms = 60_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('doorbell: a token only for someone GitHub says can read the repo', async () => {
  const t = await setup();
  try {
    assert.equal((await mint(t, null)).status, 401);
    assert.equal((await mint(t, 'tok-nobody')).status, 404, 'a token GitHub does not know');
    assert.equal((await mint(t, 'tok-bob')).status, 404, 'bob cannot read acme/web');
    assert.equal((await mint(t, 'tok-ana', 'acme/unknown')).status, 404, 'a repo the service does not know');
    assert.equal((await mint(t, 'tok-ana', '../x')).status, 400);
    const r = await mint(t, 'tok-ana');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.repo, 'acme/web');
    assert.ok(Date.parse(j.expiresAt) - Date.now() <= 15 * 60_000);
    assert.doesNotMatch(JSON.stringify(t.db.auditLog?.() ?? []), /tok-ana/, 'the GitHub token is never kept');
    const bad = await fetch(`${t.base}/doorbell`, { headers: { Authorization: `Bearer ${j.token.slice(0, -2)}xx` } });
    assert.equal(bad.status, 401, 'a tampered token');
  } finally { await t.close(); }
});

test('doorbell: "run X changed", nothing more, only to listeners on that repo and run', async () => {
  const t = await setup();
  try {
    const { token } = await (await mint(t, 'tok-ana')).json();
    const all = await stream(t, token);
    const r1 = await stream(t, token, 'r1');
    await until(() => all.events.length && r1.events.length);
    assert.deepEqual(all.events[0], ['ready', {}]);
    assert.match(all.res.headers['content-type'], /text\/event-stream/);
    await t.change('r2');
    await until(() => all.events.length === 2);
    assert.deepEqual(all.events[1], ['changed', { run: 'r2' }], 'only the run id');
    assert.equal(r1.events.length, 1, 'a listener on r1 hears nothing about r2');
    await t.change('r1');
    await until(() => r1.events.length === 2);
    assert.deepEqual(r1.events[1], ['changed', { run: 'r1' }]);
    assert.equal(t.app.doorbell.ring(INST, 71, ['r1']), 0, 'another repo rings nobody here');
    all.close(); r1.close();
    await until(() => t.app.doorbell.size() === 0);
  } finally { t.app.doorbell.close(); await t.close(); }
});

test('doorbell: the stream ends when its token expires', async () => {
  let offset = 0;
  const t = await setup({ now: () => Date.now() + offset });
  try {
    const { token } = await (await mint(t, 'tok-ana')).json();
    offset = 15 * 60_000 - 300; // the token has 300 ms left
    const s = await stream(t, token, 'r1');
    await until(() => s.events.some(([e]) => e === 'expired'));
    await new Promise((ok) => (s.res.complete ? ok() : s.res.on('end', ok)));
    offset = 15 * 60_000 + 1000;
    assert.equal((await fetch(`${t.base}/doorbell`, { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'expired');
  } finally { t.app.doorbell.close(); await t.close(); }
});

test('doorbell: the skill\'s listener wakes within seconds of a push, and reconnects after the service drops it', async () => {
  const t = await setup();
  const said = [];
  let rings = 0;
  const l = listen({ service: t.base, repo: 'acme/web', run: 'r1', token: () => 'tok-ana', onRing: () => { rings++; }, say: (x) => said.push(x), minRetryMs: 50 });
  try {
    await until(() => said.includes('doorbell on'));
    // The listener has no poller of its own: a ring can only come from the doorbell stream, after this push.
    assert.equal(rings, 0);
    await t.change('r1');
    await until(() => rings === 1);
    t.app.doorbell.close(); // the service restarts its streams
    await until(() => said.includes('doorbell lost; polling until it is back'));
    await until(() => t.app.doorbell.size() === 1);
    await t.change('r1');
    await until(() => rings === 2);
  } finally { l.stop(); t.app.doorbell.close(); await t.close(); }
});

test('doorbell: a person without access is told once and keeps polling', async () => {
  const t = await setup();
  const said = [];
  const l = listen({ service: t.base, repo: 'acme/web', run: 'r1', token: () => 'tok-bob', onRing: () => {}, say: (x) => said.push(x), maxRetryMs: 100_000 });
  try {
    await until(() => said.length === 1);
    assert.deepEqual(said, ['doorbell refused (HTTP 404); polling only']);
  } finally { l.stop(); await t.close(); }
});
