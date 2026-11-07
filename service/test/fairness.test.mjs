// c14 round 3: one tenant cannot stall ingest for the others. Reads share a small worker pool,
// taken in turn per installation; a large read never takes the last worker; each installation has
// a reading budget per hour; one sync reads at most LIMITS.syncBytes of logs. The first test is the
// critic's proof (q3/q4): an attacker floods with 8 MB logs that are slow to mask, and another
// tenant's small run must still sync, and /healthz answer, while the attacker's reads are under way.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { ingester, LIMITS, readLog } from '../src/ingest.mjs';
import { DEFERRED, parser, parserSettings } from '../src/parser.mjs';
import { fakeGitHub, makeRun, startApp, stateFiles } from './helpers.mjs';

const made = new Map(); // makeRun drives the CLI, which is slow: one run per id for the whole file
const run = (id) => { if (!made.has(id)) made.set(id, makeRun(id)); return made.get(id); };
const SLOW = '://x'.repeat(15000); // valid text that costs the masking pass the most, and compresses to nothing in git
// A valid run log of about `bytes`, made of notes of SLOW text.
function bigLog(id, bytes) {
  const base = run(id);
  let seq = base.toString('utf8').trim().split('\n').length; let len = base.length;
  const parts = [base];
  while (len + 70_000 < bytes) {
    const line = Buffer.from(`${JSON.stringify({ v: 1, seq: ++seq, at: new Date().toISOString(), kind: 'state.edited', payload: { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'person', text: SLOW, at: '2026-11-07T10:00:00.000Z' }] }] } })}\n`);
    parts.push(line); len += line.length;
  }
  return Buffer.concat(parts);
}
const small = makeRun('r1', { goal: 'victim' });

test('q4: an attacker pushing 8 MB logs to their own repos does not hold up another tenant: its small run syncs while theirs are still being read', async () => {
  const runs = { r1: bigLog('r1', LIMITS.logBytes), r2: bigLog('r2', LIMITS.logBytes), r3: bigLog('r3', LIMITS.logBytes) };
  const t = await startApp();
  try {
    for (let k = 0; k < 2; k++) t.gh.addRepo(`mallory/own${k}`, { id: 90 + k, installationId: 66, files: stateFiles(runs) });
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: small }) });
    await t.db.upsertInstallation({ id: 7, account: 'acme' });
    await t.db.upsertInstallation({ id: 66, account: 'mallory' }); // a push from an unknown installation is ignored, and would prove nothing
    const hook = async (body) => {
      const b = JSON.stringify(body);
      const sig = `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(b).digest('hex')}`;
      return (await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': String(Math.random()), 'X-Hub-Signature-256': sig } })).status;
    };
    // Settles when the attacker's first log is fetched; its read is handed to the pool right after.
    const orig = t.gh.blob; let fetched; const reading = new Promise((r) => { fetched = r; });
    t.gh.blob = async (tok, full, ...a) => { const b = await orig(tok, full, ...a); if (full.startsWith('mallory/')) fetched(); return b; };
    const codes = await Promise.all([0, 1].map((k) => hook({ ref: 'refs/heads/coordinator-state', installation: { id: 66 }, repository: { id: 90 + k, full_name: `mallory/own${k}`, private: true, owner: { login: 'mallory' } } })));
    assert.deepEqual(codes, [202, 202]);
    await reading; await new Promise((r) => setImmediate(r)); // the attacker's reads are under way
    // Ordered, not timed: the other tenant's sync and /healthz both finish while every attacker sync,
    // six 8 MB logs that share one worker, is still unfinished.
    const [out] = await t.app.ingest.syncInstallation(7);
    assert.deepEqual(out.updated, ['r1']);
    assert.equal((await fetch(`${t.base}/healthz`)).status, 200, 'the event loop stays free');
    const attacker = await t.db.repos(66);
    assert.equal(attacker.length, 2);
    assert.ok(attacker.every((r) => !r.syncedAt), `the attacker's syncs finished first: ${JSON.stringify(attacker.map((r) => r.syncedAt))}`);
  } finally { await t.app.ingest.close(); await t.close(); } // close first: the attacker's queued reads end as errors
});

test('pool: installations take turns; one with many queued reads does not go before another', async () => {
  const p = parser({ workers: 1 });
  try {
    const order = [];
    const read = (tenant, i) => p.readLog('r1', small, tenant).then((r) => { assert.equal(r.seq, 7); order.push(`${tenant}${i}`); });
    await Promise.all([read('a', 1), read('a', 2), read('a', 3), read('a', 4), read('b', 1)]);
    assert.ok(order.indexOf('b1') <= 2, `b went third at the latest: ${order}`);
  } finally { await p.close(); }
});

test('pool: a large read never takes the last worker, so a small one is read at once', async () => {
  const big = bigLog('r1', 1024 * 1024);
  const p = parser({ workers: 2, smallBytes: 64 * 1024 });
  try {
    // Warm both workers first, so a worker's start-up is not what is measured.
    const warm = await Promise.all([p.readLog('r1', big, 'x'), p.readLog('r1', small, 'y')]);
    assert.deepEqual(warm.map((r) => r.error), [undefined, undefined]);
    // Ordered, not timed: three large reads are queued, then one small one. If large reads could take
    // both workers, the small read would wait for one of them to finish; it finishes first instead.
    const done = [];
    const bigs = [1, 2, 3].map((i) => p.readLog('r1', big, 'mallory').then((r) => { done.push(`big${i}`); return r; }));
    const tiny = p.readLog('r1', small, 'acme').then((r) => { done.push('small'); return r; });
    assert.equal((await tiny).seq, 7);
    assert.deepEqual(done, ['small'], `the small read waited behind a large one: ${done}`);
    for (const r of await Promise.all(bigs)) assert.equal(r.error, undefined, r.error);
    assert.deepEqual(done, ['small', 'big1', 'big2', 'big3'], 'the large reads take the one worker in turn');
  } finally { await p.close(); }
});

test('budget: past its reading time for the hour an installation is deferred, others are not; the hour resets it', async () => {
  let clock = 0;
  const p = parser({ workers: 1, budgetMs: 1, now: () => clock });
  try {
    clock = 0; const first = p.readLog('r1', small, 66);
    clock = 5; assert.equal((await first).seq, 7, 'the first read runs');
    assert.ok(p.spent(66) >= 1);
    assert.deepEqual(await p.readLog('r1', small, 66), { error: DEFERRED, deferred: true });
    assert.equal((await p.readLog('r1', small, 7)).seq, 7, 'another installation reads on');
    clock = 3_700_000;
    assert.equal((await p.readLog('r1', small, 66)).seq, 7, 'a new hour, a new budget');
  } finally { await p.close(); }
});

function setup(runs, parse) {
  const gh = fakeGitHub(); const db = guard(memoryDb());
  gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles(runs) });
  const warned = [];
  const log = { info() {}, warn: (m, x) => warned.push([m, x]), error() {} };
  return { gh, db, warned, ingest: ingester({ db, gh, log, parse }), prep: async () => { await db.upsertInstallation({ id: 7, account: 'acme' }); await db.upsertRepo({ installationId: 7, id: 70, fullName: 'acme/web' }); } };
}
const REPO = { id: 70, fullName: 'acme/web' };

test('budget: a deferred log keeps the repo owed and is logged; the next sync reads it', async () => {
  let clock = 0;
  const p = parser({ workers: 1, budgetMs: 1, now: () => clock });
  const t = setup({ r1: run('r1'), r2: run('r2') }, p);
  try {
    await t.prep();
    const origRead = p.readLog;
    p.readLog = async (...a) => { const r = origRead(...a); clock += 2; return r; }; // each read costs 2 ms of the 1 ms budget
    let out = await t.ingest.syncRepo(7, REPO);
    assert.deepEqual(out.updated, ['r1']);
    assert.deepEqual(out.later, ['r2']);
    let repo = (await t.db.repos(7))[0];
    assert.equal(repo.headSha, null, 'the head is not recorded, so the next sync is not skipped as unchanged');
    assert.match(repo.error, /1 file left for the next sync: this installation used its reading time/);
    assert.ok(t.warned.some(([m]) => /left logs for later/.test(m)));
    clock += 3_600_000;
    out = await t.ingest.syncRepo(7, REPO);
    assert.deepEqual(out.updated, ['r2'], 'only the owed log is read');
    repo = (await t.db.repos(7))[0];
    assert.ok(repo.headSha, 'all read: the head is recorded');
    assert.equal(repo.error, null);
  } finally { await t.ingest.close(); }
});

test('sync byte cap: one sync reads at most LIMITS.syncBytes of logs, the rest follow at the next syncs', async () => {
  const keep = LIMITS.syncBytes;
  LIMITS.syncBytes = 1; // every sync reads one log
  const t = setup({ r1: run('r1'), r2: run('r2'), r3: run('r3') }, null);
  try {
    await t.prep();
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await t.ingest.syncRepo(7, REPO)).updated);
    assert.deepEqual(seen, [['r1'], ['r2'], ['r3']]);
    assert.equal((await t.db.repos(7))[0].error, null);
    assert.equal((await t.ingest.syncRepo(7, REPO)).unchanged, true);
  } finally { LIMITS.syncBytes = keep; await t.ingest.close(); }
});

test('sync byte cap with --force: each forced sync carries on where the last stopped, then a new pass starts', async () => {
  const keep = LIMITS.syncBytes;
  const t = setup({ r1: run('r1'), r2: run('r2'), r3: run('r3') }, null);
  try {
    await t.prep();
    for (let i = 0; i < 3; i++) await t.ingest.syncRepo(7, REPO); // all three stored
    LIMITS.syncBytes = 1; // every sync reads one log
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await t.ingest.syncRepo(7, REPO, { force: true })).updated);
    assert.deepEqual(seen, [['r1'], ['r2'], ['r3']], 'not r1 three times');
    assert.equal((await t.db.repos(7))[0].error, null, 'the forced pass finished');
    assert.deepEqual((await t.ingest.syncRepo(7, REPO, { force: true })).updated, ['r1'], 'the next --force is a new pass');
  } finally { LIMITS.syncBytes = keep; await t.ingest.close(); }
});

test('readLog: a log under another run folder is refused from its first line, before the masking pass', () => {
  // The rest of the log is not JSON: a refusal that came after parsing (and so after masking) would say so.
  const big = Buffer.concat([bigLog('r1', 2 * 1024 * 1024), Buffer.from('not json\n')]);
  assert.match(readLog('r1', big).error, /JSON|line/i, 'read whole, the log fails on its last line');
  assert.match(readLog('r9', big).error, /describes run "r1", not r9/);
});

test('settings: defaults, and a value out of range is refused', () => {
  assert.deepEqual(parserSettings({}), { workers: 2, budgetMs: 600_000, smallBytes: 512 * 1024 });
  assert.deepEqual(parserSettings({ PARSE_WORKERS: '4', PARSE_BUDGET_SECONDS: '60', PARSE_SMALL_KB: '256' }), { workers: 4, budgetMs: 60_000, smallBytes: 256 * 1024 });
  assert.throws(() => parserSettings({ PARSE_WORKERS: '0' }), /PARSE_WORKERS/);
  assert.throws(() => parserSettings({ PARSE_BUDGET_SECONDS: 'lots' }), /PARSE_BUDGET_SECONDS/);
});
