// c14: syncs are bounded (the critic's s1 proof: 200 signed pushes from one installation, each an
// 8 MB log, took the process to 2 GB), an uninstalled installation stays gone (s4), `sync <id>`
// stores nothing GitHub does not confirm, and a forced re-read is carried on across processes.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { sync as cliSync } from '../src/cli.mjs';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { ingester, LIMITS } from '../src/ingest.mjs';
import { byteBudget, syncQueue, syncSettings } from '../src/syncqueue.mjs';
import { appendEvent, fakeGitHub, makeRun, startApp, stateFiles } from './helpers.mjs';

const PG = process.env.TEST_DATABASE_URL;
let schemas = 0;
async function freshDb(kind) {
  if (kind === 'memory') return guard(memoryDb());
  const { postgresDb } = await import('../src/db/postgres.mjs');
  return guard(await postgresDb(PG, { max: 3, schema: `s_${process.pid}_${++schemas}` }));
}
const KINDS = [['memory', false], ['postgres', !PG && 'set TEST_DATABASE_URL to run against Postgres']];
const tick = () => new Promise((r) => setImmediate(r));
const sign = (secret, b) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;
async function hook(t, event, body) {
  const b = JSON.stringify(body);
  const r = await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': String(Math.random()), 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, b) } });
  return [r.status, await r.text()];
}

test('settings: defaults 4 syncs, 2 per installation, 64 MB of blobs; out of range is refused', () => {
  assert.deepEqual(syncSettings({}), { concurrency: 4, perInstallation: 2, blobBytes: 64 * 1024 * 1024 });
  assert.throws(() => syncSettings({ SYNC_BLOB_MB: '8' }), /SYNC_BLOB_MB=8 \(16-4096\)/);
  assert.throws(() => syncSettings({ SYNC_CONCURRENCY: '0' }), /SYNC_CONCURRENCY/);
});

test('queue: at most N at once and P per installation, installations in turn, a queued repo asked again joins it', async () => {
  const q = syncQueue({ concurrency: 3, perInstallation: 2 });
  const live = new Map(); let most = 0; const started = []; const gates = [];
  const job = (tenant, key) => q.submit(tenant, key, { force: false }, async (o) => {
    started.push(`${key}${o.force ? '!' : ''}`);
    live.set(tenant, (live.get(tenant) ?? 0) + 1); most = Math.max(most, [...live.values()].reduce((a, b) => a + b, 0));
    assert.ok(live.get(tenant) <= 2, 'per installation');
    await new Promise((r) => gates.push(r));
    live.set(tenant, live.get(tenant) - 1);
    return key;
  }, (a, b) => ({ force: a.force || b.force }));
  const all = [];
  for (let k = 0; k < 6; k++) all.push(job('A', `A${k}`));
  const b0 = job('B', 'B0');
  // A0 and A1 run; A2 waits for A's limit, B0 takes the third slot.
  await tick();
  assert.deepEqual(started, ['A0', 'A1', 'B0']);
  // Asked again while queued: the same sync, made forced, one result.
  const again = q.submit('A', 'A5', { force: true }, () => assert.fail('never a second job'), (a, b) => ({ force: a.force || b.force }));
  assert.equal(q.stats().queued, 4);
  while (q.stats().running || q.stats().queued) { if (gates.length) gates.shift()(); await tick(); }
  assert.deepEqual(await Promise.all([...all, b0, again]), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'B0', 'A5']);
  assert.ok(started.includes('A5!'), 'the joined request made it forced');
  assert.equal(started.length, 7);
  assert.ok(most <= 3);
});

test('byte budget: takes wait their turn, and a request larger than the budget still fits alone', async () => {
  const b = byteBudget(10);
  const a = await b.take(6);
  let second = false; const p = b.take(6).then((n) => { second = true; return n; });
  await tick(); assert.equal(second, false, 'waits for room');
  b.give(a); assert.equal(await p, 6);
  b.give(6);
  assert.equal(await b.take(50), 10, 'capped at the budget');
});

const SLOW = '://x'.repeat(15000);
function bigLog(id, bytes) {
  let log = makeRun(id);
  while (log.length + 70_000 < bytes) log = appendEvent(log, 'state.edited', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'person', text: SLOW, at: '2026-11-07T10:00:00.000Z' }] }] });
  return log;
}

test('s1: 200 signed pushes of 8 MB logs from one installation keep memory bounded; another installation still syncs at once', { timeout: 120_000 }, async () => {
  const N = 200;
  const log = bigLog('r1', LIMITS.logBytes);
  const gh = fakeGitHub();
  // Like the real client: JSON text with base64 content, parsed and decoded.
  const orig = gh.blob.bind(gh);
  gh.blob = async (...a) => { const b = await orig(...a); const text = JSON.stringify({ encoding: 'base64', content: b.toString('base64') }); await new Promise((r) => setTimeout(r, 5)); return Buffer.from(JSON.parse(text).content, 'base64'); };
  const t = await startApp({ gh });
  let closed = false;
  try {
    await t.db.upsertInstallation({ id: 66, account: 'mallory' });
    await t.db.upsertInstallation({ id: 77, account: 'victim' });
    for (let k = 0; k < N; k++) gh.addRepo(`mallory/r${k}`, { id: 1000 + k, installationId: 66, files: stateFiles({ r1: log }) });
    gh.addRepo('victim/web', { id: 5000, installationId: 77, files: stateFiles({ r1: makeRun('r1', { goal: 'victim' }) }) });
    const base = process.memoryUsage().rss; let peak = base;
    const mon = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const push = (inst, id, full) => hook(t, 'push', { ref: 'refs/heads/coordinator-state', installation: { id: inst }, repository: { id, full_name: full, private: true } });
    const codes = await Promise.all(Array.from({ length: N }, (_, k) => push(66, 1000 + k, `mallory/r${k}`)));
    assert.deepEqual([...new Set(codes.map((c) => c[0]))], [202]);
    // The other installation pushes into the flood; its run is read within a couple of seconds.
    const began = performance.now();
    await push(77, 5000, 'victim/web');
    while (!(await t.db.run(77, 5000, 'r1'))?.state) await new Promise((r) => setTimeout(r, 25));
    const victimMs = performance.now() - began;
    // /healthz stays quick while the flood is read.
    let slowest = 0;
    for (let i = 0; i < 20; i++) { const a = performance.now(); await fetch(`${t.base}/healthz`); slowest = Math.max(slowest, performance.now() - a); await new Promise((r) => setTimeout(r, 50)); }
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(mon);
    const s = t.app.ingest.stats();
    const MB = (x) => Math.round(x / 1048576);
    console.log(`# s1: ${N} pushes; rss ${MB(base)} -> peak ${MB(peak)} MB; victim synced in ${Math.round(victimMs)} ms; slowest /healthz ${Math.round(slowest)} ms; syncs at once peak ${s.peak}; blob bytes peak ${MB(s.blobBytes.peak)} MB`);
    assert.ok(s.peak <= 4, 'at most 4 syncs at once');
    assert.ok(s.blobBytes.peak <= 64 * 1048576, 'blob bytes held within the budget');
    assert.ok(peak - base < 400 * 1048576, `memory grew ${MB(peak - base)} MB`);
    assert.ok(victimMs < 3000, `the other installation waited ${Math.round(victimMs)} ms`);
    assert.ok(slowest < 1000, `/healthz took ${Math.round(slowest)} ms`);
    // Queued syncs are dropped on close; the running ones finish.
    await t.app.ingest.close(); closed = true;
  } finally {
    if (!closed) await t.app.ingest.close();
    await t.close();
  }
});

for (const [kind, skip] of KINDS) {
  test(`${kind}: s4, a late installation.created after deleted does not bring the installation back`, { skip }, async () => {
    const t = await startApp({ db: await freshDb(kind) });
    try {
      const inst = { id: 55, account: { login: 'gone' } };
      assert.deepEqual(await hook(t, 'installation', { action: 'created', installation: inst, sender: { login: 'gone' } }), [202, 'syncing']);
      await t.app.idle();
      assert.deepEqual(await hook(t, 'installation', { action: 'deleted', installation: inst, sender: { login: 'gone' } }), [200, 'removed']);
      // A late copy of the first delivery (a different body: a replayed one is skipped earlier, as a duplicate).
      assert.deepEqual(await hook(t, 'installation', { action: 'created', installation: inst, sender: { login: 'gone', id: 2 } }), [202, 'ignored: uninstalled']);
      assert.deepEqual(await hook(t, 'push', { ref: 'refs/heads/coordinator-state', installation: { id: 55 }, repository: { id: 1, full_name: 'gone/x' } }), [202, 'ignored: unknown installation']);
      await t.app.idle();
      assert.equal(await t.db.installation(55), null);
      assert.deepEqual(await t.db.installationIds(), []);
      assert.equal(await t.db.wasUninstalled(55), true);
      assert.equal(await t.db.upsertInstallation({ id: 55, account: 'gone' }), false, 'the store itself refuses it');
      assert.equal(await t.db.upsertInstallation({ id: 56, account: 'new' }), true);
    } finally { await t.close(); }
  });

  test(`${kind}: sync <id> stores the installation only once GitHub confirms it`, { skip }, async () => {
    const db = await freshDb(kind); const gh = fakeGitHub();
    const ingest = ingester({ db, gh });
    try {
      const real = gh.installationToken.bind(gh);
      gh.installationToken = async (id, ...a) => { if (id === 999) throw new Error('GitHub 404: installation token'); return real(id, ...a); };
      await assert.rejects(cliSync({ db, gh, ingest, args: ['999'] }), /404/);
      assert.equal(await db.installation(999), null, 'nothing stored for an id GitHub refused');
      gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
      const out = await cliSync({ db, gh, ingest, args: ['7'] });
      assert.deepEqual(out[0].repos[0].updated, ['r1']);
      assert.ok(await db.installation(7));
      await db.deleteInstallation(7);
      await assert.rejects(cliSync({ db, gh, ingest, args: ['7'] }), /was uninstalled/);
      assert.equal(await db.installation(7), null);
    } finally { await ingest.close(); await db.close(); }
  });

  test(`${kind}: a forced re-read larger than one sync completes across processes, and the server's normal sync carries it on`, { skip }, async () => {
    const keep = LIMITS.syncBytes;
    const db = await freshDb(kind); const gh = fakeGitHub();
    const REPO = { id: 70, fullName: 'acme/web' };
    gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1'), r2: makeRun('r2'), r3: makeRun('r3'), r4: makeRun('r4') }) });
    // Each "process" is a fresh ingester over the same database, as each `npm run sync` is.
    const fresh = () => ingester({ db, gh });
    const once = async (opts) => { const i = fresh(); try { return await i.syncRepo(7, REPO, opts); } finally { await i.close(); } };
    try {
      await db.upsertInstallation({ id: 7, account: 'acme' }); await db.upsertRepo({ installationId: 7, ...REPO });
      assert.equal((await once()).updated.length, 4);
      LIMITS.syncBytes = 1; // every sync reads one log
      assert.deepEqual((await once({ force: true })).updated, ['r1']);
      assert.deepEqual((await once({ force: true })).updated, ['r2'], 'a second --force in a new process carries on, not r1 again');
      assert.equal((await db.repos(7))[0].reread, true);
      // The head has not moved, but the server's normal sync does not skip the unfinished pass.
      assert.deepEqual((await once()).updated, ['r3']);
      assert.deepEqual((await once()).updated, ['r4']);
      const repo = (await db.repos(7))[0];
      assert.equal(repo.reread, false, 'the pass is done');
      assert.equal(repo.error, null);
      assert.equal((await once()).unchanged, true, 'and the next normal sync skips the unchanged repo again');
      assert.deepEqual((await db.runs(7, 70)).map((r) => [r.runId, Boolean(r.state), Boolean(r.eventsSha)]), [['r1', true, true], ['r2', true, true], ['r3', true, true], ['r4', true, true]], 'state kept throughout');
    } finally { LIMITS.syncBytes = keep; await db.close(); }
  });
}
