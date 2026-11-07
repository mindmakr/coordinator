// Round 3 of the c11 review: webhook flood, resync, and caps on what one run log can make the App write.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { MAX_REFS_PER_UNIT, readLog } from '../src/ingest.mjs';
import { MAX_REPOS_PER_VIEW } from '../src/server.mjs';
import { CAPS } from '../src/trail.mjs';
import { appendEvent, makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

const PR = 'https://github.com/acme/web/pull/12';
const MOBILE_PR = 'https://github.com/acme/mobile/pull/5';
const OPTED_IN = { 'coordinator.json': { primary: 'acme/web' } };

async function world({ runs = { r1: makeRun('r1', { prs: [PR, MOBILE_PR] }) }, gh, db, over = {} } = {}) {
  let clock = Date.parse('2026-11-06T12:00:00Z');
  const t = await startApp({ now: () => clock, over, ...(gh && { gh }), ...(db && { db }) });
  t.tick = (ms) => { clock += ms; };
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles(runs, { repos: ['acme/mobile'] }) });
  t.gh.addRepo('acme/mobile', { id: 71, installationId: 7, defaultFiles: OPTED_IN });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  return t;
}
const note = (buf, text) => appendEvent(buf, 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'info', text, at: '2026-11-06T10:00:00.000Z' }] }] });
const bump = (buf) => appendEvent(buf, 'unit.reset', { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'status'], value: 'stopped' }] }, 'u1');

test('a flood of wrongly signed deliveries from a shared address never blocks a correctly signed one', async () => {
  const t = await world({ over: { webhookSources: ['127.0.0.0/8'] } }); // c14: the header counts only from GitHub's addresses; here, this one
  // GitHub names the App a delivery is for; someone else's App delivering from the same addresses names its own.
  const post = (body, sig, app = '999') => fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig, 'X-GitHub-Hook-Installation-Target-Type': 'integration', 'X-GitHub-Hook-Installation-Target-ID': app } });
  try {
    let last;
    for (let i = 0; i < 40; i++) last = await post('{"zen":"x"}', `sha256=${'0'.repeat(64)}`);
    assert.equal(last.status, 429, 'the refused ones are limited');
    const good = '{"zen":"ours"}';
    const sig = `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(good).digest('hex')}`;
    assert.equal((await post(good, sig)).status, 429, 'over the limit, a delivery for another App is turned away before its body is read');
    const r = await post(good, sig, t.cfg.github.appId);
    assert.equal(r.status, 200, 'ours still gets through');
  } finally { await t.close(); }
});

test('the periodic resync picks up a push whose webhook never arrived', async () => {
  const log = makeRun('r1');
  const t = await world({ runs: { r1: log } });
  try {
    await t.app.resyncAll();
    assert.equal((await t.db.runs(7, 70))[0].seq, 7);
    t.gh.setFiles('acme/web', stateFiles({ r1: note(log, 'later') }, { repos: ['acme/mobile'] })); // no delivery
    await t.app.resyncAll();
    assert.equal((await t.db.runs(7, 70))[0].seq, 8, 'healed without a webhook');
  } finally { await t.close(); }
});

test('a run with more than 50 units is refused at ingest', async () => {
  const base = makeRun('r1');
  const unit = readLog('r1', base).state.units[0];
  let buf = base;
  for (let i = 2; i <= 51; i++) buf = appendEvent(buf, 'unit.add', { ops: [{ op: 'push', path: ['units'], values: [{ ...unit, id: `u${i}` }] }] }, `u${i}`);
  assert.match(readLog('r1', buf).error, /51 units; at most 50/);
});

const written = (t) => ['acme/web#12', 'acme/mobile#5'].filter((k) => (t.gh.comments.get(k) ?? []).length).length;
const commentCounts = (t) => ['acme/web#12', 'acme/mobile#5'].map((k) => (t.gh.comments.get(k) ?? []).length);
const owed = async (t) => (await t.db.runs(7, 70))[0].trailPending;

test('comment writes per installation are capped; the deferred one lands at a later periodic resync with the tip unchanged', async () => {
  const keep = CAPS.commentWritesPerInstallation;
  CAPS.commentWritesPerInstallation = 1;
  try {
    const t = await world();
    try {
      await t.app.resyncAll();
      assert.equal(written(t), 1, 'one write, one deferred');
      assert.equal(await owed(t), true, 'the run is marked as owed a comment');
      await t.app.resyncAll();
      assert.equal(written(t), 1, 'still inside the window: still held back');
      t.tick(CAPS.windowMs + 1);
      const r = await t.app.resyncAll(); // no force, the branch tip has not moved
      assert.equal(r[0].repos.find((x) => x.repo === 'acme/web').unchanged, true);
      assert.equal(written(t), 2, 'the deferred one lands later');
      assert.equal(await owed(t), false, 'nothing owed any more');
      t.tick(CAPS.windowMs + 1);
      await t.app.resyncAll();
      assert.deepEqual(commentCounts(t), [1, 1], 'one comment each, never a second');
    } finally { await t.close(); }
  } finally { CAPS.commentWritesPerInstallation = keep; }
});

test('a deferred comment survives a restart and lands once', async () => {
  const keep = CAPS.commentWritesPerInstallation;
  CAPS.commentWritesPerInstallation = 1;
  try {
    const t1 = await world();
    await t1.app.resyncAll();
    assert.equal(written(t1), 1);
    await new Promise((ok) => t1.app.server.close(ok)); await t1.app.idle(); // the process stops; the database stays
    const t2 = await world({ gh: t1.gh, db: t1.db });
    try {
      await t2.app.resyncAll();
      assert.equal(written(t2), 2, 'the new process writes what the old one owed');
      await t2.app.resyncAll();
      assert.deepEqual(commentCounts(t2), [1, 1], 'no duplicate after the restart');
    } finally { await t2.close(); }
  } finally { CAPS.commentWritesPerInstallation = keep; }
});

// Round 4: a refresh started by a merge or check webhook flags what it could not write, too.
const signed = (t) => (event, payload, delivery) => {
  const body = JSON.stringify(payload);
  return fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(body).digest('hex')}` } });
};
const merged = (full, id, n, at) => ({ action: 'closed', installation: { id: 7 }, repository: { id, full_name: full, private: true }, pull_request: { number: n, merged: true, merged_at: at } });
const body = (t, k) => (t.gh.comments.get(k) ?? []).map((c) => c.body).join('\n');

test('a merge webhook whose comment is over the write budget is flagged and lands at a later resync, once', async () => {
  const keep = CAPS.commentWritesPerInstallation;
  CAPS.commentWritesPerInstallation = 1;
  try {
    const t = await world();
    const hook = signed(t);
    try {
      await t.app.resyncAll(); t.tick(CAPS.windowMs + 1); await t.app.resyncAll();
      assert.deepEqual(commentCounts(t), [1, 1]);
      assert.equal(await owed(t), false);
      t.tick(CAPS.windowMs + 1);
      await hook('pull_request', merged('acme/mobile', 71, 5, '2026-11-06T11:00:00Z'), 'm1'); await t.app.idle();
      await hook('pull_request', merged('acme/web', 70, 12, '2026-11-06T11:01:00Z'), 'w1'); await t.app.idle();
      assert.match(body(t, 'acme/mobile#5'), /merged/, 'the first merge used the one write');
      assert.doesNotMatch(body(t, 'acme/web#12'), /merged/, 'the second is held back');
      assert.equal(await owed(t), true, 'and the run is flagged for it');
      t.tick(CAPS.windowMs + 1);
      const r = await t.app.resyncAll(); // no force, the branch tip has not moved
      assert.equal(r[0].repos.find((x) => x.repo === 'acme/web').unchanged, true);
      assert.match(body(t, 'acme/web#12'), /merged/, 'it lands without a new push');
      assert.equal(await owed(t), false);
      assert.deepEqual(commentCounts(t), [1, 1], 'edited in place, never a second comment');
    } finally { await t.close(); }
  } finally { CAPS.commentWritesPerInstallation = keep; }
});

test('a check webhook whose refresh fails partway is flagged and retried at the next resync, once', async () => {
  const t = await world();
  const hook = signed(t);
  try {
    await t.app.resyncAll();
    assert.deepEqual(commentCounts(t), [1, 1]);
    const update = t.gh.updateComment;
    t.gh.updateComment = async () => { throw new Error('GitHub 502'); };
    await hook('check_suite', { action: 'completed', installation: { id: 7 }, repository: { id: 70, full_name: 'acme/web', private: true }, check_suite: { id: 55, conclusion: 'failure', head_sha: 'abc', updated_at: '2026-11-06T10:30:00Z', pull_requests: [{ number: 12 }] } }, 'c1');
    await t.app.idle();
    assert.doesNotMatch(body(t, 'acme/web#12'), /failure/);
    assert.equal(await owed(t), true, 'the failed refresh is flagged');
    t.gh.updateComment = update;
    await t.app.resyncAll();
    assert.match(body(t, 'acme/web#12'), /failure/, 'the checks result lands at the next resync');
    assert.equal(await owed(t), false);
    assert.deepEqual(commentCounts(t), [1, 1], 'edited in place, never a second comment');
  } finally { await t.close(); }
});

test('links per unit are capped at ingest, and a page view checks access only for linked repos with events', async () => {
  let buf = makeRun('r1');
  const links = Array.from({ length: 2000 }, (_, i) => ({ kind: 'issue', url: `https://github.com/evil${i}/x/issues/1` }));
  buf = appendEvent(buf, 'unit.link', { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'links'], value: links }] }, 'u1');
  const t = await world({ runs: { r1: buf } });
  try {
    t.gh.addUser('tok-v', { id: 5, login: 'viewer', read: ['acme/web'] });
    await t.app.ingest.syncInstallation(7);
    let stored = 0;
    for (let i = 0; i < 2000; i++) stored += (await t.db.runsReferencing(7, `evil${i}/x#1`)).length;
    assert.equal(stored, MAX_REFS_PER_UNIT, 'only the first links of the unit are stored');
    const cookie = await signIn(t, 'v');
    const from = t.gh.calls.length;
    const r = await fetch(`${t.base}/r/acme/web/run/r1`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(t.gh.count('repoAccess', from), 1, 'only the state repo: no linked repo has events');
  } finally { await t.close(); }
});

test('a page view checks at most MAX_REPOS_PER_VIEW linked repos, even when all of them have events', async () => {
  const base = makeRun('r1');
  const unit = readLog('r1', base).state.units[0];
  let buf = base;
  const keys = [];
  for (let u = 1; u <= 5; u++) {
    const links = Array.from({ length: MAX_REFS_PER_UNIT }, (_, i) => ({ kind: 'issue', url: `https://github.com/other${u}x${i}/x/issues/1` }));
    keys.push(...links.map((l) => l.url.replace('https://github.com/', '').replace('/issues/', '#')));
    if (u === 1) buf = appendEvent(buf, 'unit.link', { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'links'], value: links }] }, 'u1');
    else buf = appendEvent(buf, 'unit.add', { ops: [{ op: 'push', path: ['units'], values: [{ ...unit, id: `u${u}`, links }] }] }, `u${u}`);
  }
  const t = await world({ runs: { r1: buf } });
  try {
    t.gh.addUser('tok-v', { id: 5, login: 'viewer', read: ['acme/web'] });
    await t.app.ingest.syncInstallation(7);
    for (const k of keys) await t.db.addGhEvent(7, { id: `closed:${k}`, refKey: k, kind: 'closed', at: '2026-11-06T11:00:00.000Z', detail: { label: 'Issue' } });
    const cookie = await signIn(t, 'v');
    const from = t.gh.calls.length;
    const r = await fetch(`${t.base}/r/acme/web/run/r1`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(t.gh.count('repoAccess', from), 1 + MAX_REPOS_PER_VIEW, `${keys.length} linked repos, ${MAX_REPOS_PER_VIEW} checked`);
  } finally { await t.close(); }
});

test('a webhook whose Content-Length is over 5 MB is refused before the body is read', async () => {
  const t = await world();
  try {
    const { request } = await import('node:http');
    const status = await new Promise((ok, fail) => {
      const req = request(`${t.base}/webhook`, { method: 'POST', headers: { 'Content-Length': String(6 * 1024 * 1024), 'X-GitHub-Event': 'ping' } }, (res) => { res.resume(); ok(res.statusCode); });
      req.on('error', fail);
      req.write('{}'); // a few bytes, never the rest: only the header can have answered
    });
    assert.equal(status, 413);
  } finally { await t.close(); }
});

test('the server bounds connections and request time', async () => {
  const t = await world();
  try {
    assert.ok(t.app.server.maxConnections > 0 && t.app.server.maxConnections <= 100_000);
    assert.ok(t.app.server.requestTimeout > 0 && t.app.server.requestTimeout <= 60_000);
  } finally { await t.close(); }
});

test('consent withdrawn after a comment exists: no further edits there, once the 60 s consent check expires', async () => {
  const log = makeRun('r1', { prs: [PR, MOBILE_PR] });
  const t = await world({ runs: { r1: log } });
  try {
    await t.app.ingest.syncInstallation(7);
    const mobile = t.gh.comments.get('acme/mobile#5')[0];
    const before = mobile.body;
    t.gh.repos.get('acme/mobile').defaultFiles = { 'coordinator.json': { primary: 'acme/other' } };
    t.tick(61_000);
    t.gh.setFiles('acme/web', stateFiles({ r1: bump(log) }, { repos: ['acme/mobile'] }));
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
    assert.match(t.gh.comments.get('acme/web#12')[0].body, /\*\*State:\*\* stopped/, 'the state repo is still kept current');
    assert.equal(t.gh.comments.get('acme/mobile#5')[0].body, before, 'the withdrawn repo is left alone');
    assert.equal(t.gh.calls.some((c) => c[0] === 'updateComment' && c[2] === mobile.id), false);
  } finally { await t.close(); }
});
