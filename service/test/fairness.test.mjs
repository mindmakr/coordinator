// c14 round 3: one tenant cannot stall ingest for the others. Reads share a small worker pool,
// taken in turn per installation; a large read never takes the last worker; each installation has
// a reading budget per hour; one sync reads at most LIMITS.syncBytes of logs. The first test is the
// critic's proof (q3/q4): an attacker floods with 8 MB logs that are slow to mask, and another
// tenant's small run must still sync in under 2 s.
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

test('q4: an attacker pushing 8 MB logs to their own repos does not hold up another tenant: its small run syncs in under 2 s', async () => {
  const runs = { r1: bigLog('r1', LIMITS.logBytes), r2: bigLog('r2', LIMITS.logBytes), r3: bigLog('r3', LIMITS.logBytes) };
  const t = await startApp();
  try {
    for (let k = 0; k < 2; k++) t.gh.addRepo(`mallory/own${k}`, { id: 90 + k, installationId: 66, files: stateFiles(runs) });
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: small }) });
    await t.db.upsertInstallation({ id: 7, account: 'acme' });
    const hook = async (body) => {
      const b = JSON.stringify(body);
      const sig = `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(b).digest('hex')}`;
      return (await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': String(Math.random()), 'X-Hub-Signature-256': sig } })).status;
    };
    const codes = await Promise.all([0, 1].map((k) => hook({ ref: 'refs/heads/coordinator-state', installation: { id: 66 }, repository: { id: 90 + k, full_name: `mallory/own${k}`, private: true, owner: { login: 'mallory' } } })));
    assert.deepEqual(codes, [202, 202]);
    await new Promise((r) => setTimeout(r, 300)); // the attacker's reads are under way
    const a = Date.now();
    const [out] = await t.app.ingest.syncInstallation(7);
    const took = Date.now() - a;
    assert.deepEqual(out.updated, ['r1']);
    assert.ok(took < 2000, `the other tenant's run synced after ${took} ms`);
    const h = Date.now(); assert.equal((await fetch(`${t.base}/healthz`)).status, 200);
    assert.ok(Date.now() - h < 500, 'the event loop stays free');
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
    const a = performance.now(); const solo = await p.readLog('r1', big, 'x'); const one = performance.now() - a;
    assert.equal(solo.error, undefined, solo.error);
    const bigs = [1, 2, 3].map(() => p.readLog('r1', big, 'mallory'));
    const b = performance.now(); assert.equal((await p.readLog('r1', small, 'acme')).seq, 7);
    const waited = performance.now() - b;
    assert.ok(waited < Math.max(one / 2, 300), `the small read waited ${Math.round(waited)} ms; one large read takes ${Math.round(one)} ms`);
    await Promise.all(bigs);
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

test('readLog: a log under another run folder is refused from its first line, before the masking pass', () => {
  const big = bigLog('r1', 2 * 1024 * 1024);
  const a = performance.now(); const r = readLog('r9', big); const took = performance.now() - a;
  assert.match(r.error, /describes run "r1", not r9/);
  assert.ok(took < 100, `refused in ${Math.round(took)} ms`);
});

test('settings: defaults, and a value out of range is refused', () => {
  assert.deepEqual(parserSettings({}), { workers: 2, budgetMs: 600_000, smallBytes: 512 * 1024 });
  assert.deepEqual(parserSettings({ PARSE_WORKERS: '4', PARSE_BUDGET_SECONDS: '60', PARSE_SMALL_KB: '256' }), { workers: 4, budgetMs: 60_000, smallBytes: 256 * 1024 });
  assert.throws(() => parserSettings({ PARSE_WORKERS: '0' }), /PARSE_WORKERS/);
  assert.throws(() => parserSettings({ PARSE_BUDGET_SECONDS: 'lots' }), /PARSE_BUDGET_SECONDS/);
});
