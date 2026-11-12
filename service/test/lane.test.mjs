// c14 round 5: the trail refresh runs in a lane of its own, after the sync has given its slot back
// (the critic's s5 proof: a few installations whose trails were slow held every sync slot for about
// 25 minutes); the trail's GitHub reads are budgeted; a sync job has a time limit and refreshes an old
// token; resyncAll takes installations in turn; an uninstall stops queued and running syncs; a blob is
// charged at what reading it holds; and GitHub-origin hooks that do not name this App are capped.
// Order and gates only: no wall-clock thresholds (a guard timer only keeps a broken build from hanging).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { ingester, TOKEN_REUSE_MS } from '../src/ingest.mjs';
import { trail } from '../src/trail.mjs';
import { webhookBudget } from '../src/server.mjs';
import { BLOB_HOLD } from '../src/syncqueue.mjs';
import { fakeGitHub, makeRun, startApp, stateFiles } from './helpers.mjs';

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, guard = null) { while (!(await fn())) { if (guard?.fired) throw new Error('the guard timer fired first'); await new Promise((r) => setTimeout(r, 5)); } }
function gate() { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open: () => open() }; }
// Opens the gate after `ms` if the test has not (a hang guard, never an assertion); returns whether it fired.
function guardTimer(g, ms = 30_000) { const s = { fired: false }; s.timer = setTimeout(() => { s.fired = true; g.open(); }, ms); return s; }
const sign = (secret, b) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;
async function hook(t, event, body) {
  const b = JSON.stringify(body);
  const r = await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': String(Math.random()), 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, b) } });
  return [r.status, await r.text()];
}
// A run in `repo` whose unit links ten issues of the same repo (the most one unit's trail touches).
const refsRun = (id, repo) => makeRun(id, { issues: Array.from({ length: 10 }, (_, i) => `${repo}#${i + 1}`) });
let plain; const plainRun = () => (plain ??= makeRun('r1')); // one log, built once, for repos that need any run

test('s5: a victim syncs while other installations\' trails are held on GitHub; the sync slots are free meanwhile', { timeout: 600_000 }, async () => {
  const g = gate(); let held = 0;
  const gh = fakeGitHub(); gh.makeBoard({ items: [] });
  const g0 = gh.graphql.bind(gh);
  gh.graphql = async (...a) => { held++; await g.wait(); held--; return g0(...a); };
  const t = await startApp({ gh });
  let guarded = null;
  try {
    const board = { board: { owner: 'mallory', number: 1 }, trackers: false };
    const logs = new Map(); for (const inst of [66, 67]) for (let k = 0; k < 2; k++) logs.set(`m${inst}/r${k}`, refsRun('a1', `m${inst}/r${k}`));
    const attackers = [];
    for (const inst of [66, 67]) {
      await t.db.upsertInstallation({ id: inst, account: `m${inst}` });
      for (let k = 0; k < 2; k++) {
        const full = `m${inst}/r${k}`; const id = inst * 100 + k;
        gh.addRepo(full, { id, installationId: inst, files: stateFiles({ a1: logs.get(full) }, board) });
        await t.db.upsertRepo({ installationId: inst, id, fullName: full, private: true });
      }
    }
    await t.db.upsertInstallation({ id: 9, account: 'victim' });
    gh.addRepo('v/web', { id: 900, installationId: 9, files: stateFiles({ r1: plainRun() }) });
    await t.db.upsertRepo({ installationId: 9, id: 900, fullName: 'v/web', private: true });
    guarded = guardTimer(g, 540_000); // a hang guard only: full-suite load must never fire it
    for (const inst of [66, 67]) for (let k = 0; k < 2; k++) attackers.push(t.app.ingest.syncRepo(inst, { id: inst * 100 + k, fullName: `m${inst}/r${k}` }));
    // Every attacker sync has read its log and given its slot back; their trails wait on GitHub, one
    // per installation (TRAIL_PER_INSTALLATION), the other two queued in the lane, none in a sync slot.
    await until(() => held >= 2 && t.app.ingest.stats().running === 0 && t.app.ingest.stats().trail.queued === 2, guarded);
    const r = await t.app.ingest.syncRepo(9, { id: 900, fullName: 'v/web' });
    assert.deepEqual(r.updated, ['r1']);
    assert.equal(guarded.fired, false, 'the victim synced while the attackers\' trails were still held');
    assert.ok(t.app.ingest.stats().trail.running <= 4);
    g.open();
    for (const a of await Promise.all(attackers)) assert.deepEqual(a.updated, ['a1']);
  } finally { clearTimeout(guarded?.timer); g.open(); await t.close(); }
});

test('trail reads are budgeted per installation; a card not on the board is asked about once per state', { timeout: 60_000 }, async () => {
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const t = await startApp({ now: () => clock, over: { trailReads: 6 } });
  try {
    t.gh.makeBoard({ items: [] });
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: refsRun('r1', 'acme/web') }, { board: { owner: 'acme', number: 1 }, trackers: false }) });
    await t.db.upsertInstallation({ id: 7, account: 'acme' });
    const items = () => t.gh.calls.filter((c) => c[0] === 'graphql' && c[1] === 'CoordinatorItems').length;
    const graphql = () => t.gh.count('graphql');
    const owed = async () => (await t.db.run(7, 70, 'r1')).trailPending;
    await t.app.ingest.syncInstallation(7);
    assert.equal(graphql(), 6, 'the first refresh stops at the budget');
    assert.equal(await owed(), true, 'and the run stays owed');
    await t.app.ingest.syncInstallation(7);
    assert.equal(graphql(), 6, 'nothing more in the same window');
    let windows = 0;
    while (await owed()) { clock += 10 * 60_000 + 1; windows++; await t.app.ingest.syncInstallation(7); assert.ok(windows < 10); }
    assert.equal(items(), 10, 'each of the ten cards was asked about once: "not on board" is remembered');
    const before = graphql();
    await t.app.ingest.syncInstallation(7);
    assert.equal(graphql(), before, 'an unchanged run costs no GitHub read');
    // #42: a "not on board" answer is trusted for a day; a refresh after that asks again.
    await t.app.ingest.refreshRuns(7, 70, ['r1']);
    assert.equal(items(), 10, 'a refresh within the day asks nothing');
    clock += 24 * 3600_000 + 1;
    await t.app.ingest.refreshRuns(7, 70, ['r1']);
    assert.ok(items() > 10, 'a day later the board is asked again');
  } finally { await t.close(); }
});

// An ingester on the memory database with its own clock and settings.
async function bare({ limits = {}, now = Date.now, gh = fakeGitHub(), trail = null } = {}) {
  const db = guard(memoryDb());
  await db.upsertInstallation({ id: 5, account: 'acme' });
  const ingest = ingester({ db, gh, log: null, trail, limits: { concurrency: 4, perInstallation: 2, ...limits }, now });
  return { db, gh, ingest, close: async () => { await ingest.close(); await db.close(); } };
}

test('a sync job stops at its time limit and leaves the rest for the next sync', async () => {
  let clock = 0;
  const w = await bare({ limits: { jobMs: 1000 }, now: () => clock });
  try {
    const b0 = w.gh.blob.bind(w.gh);
    w.gh.blob = async (...a) => { clock += 2000; return b0(...a); };
    w.gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: makeRun('r1'), r2: makeRun('r2'), r3: makeRun('r3') }) });
    await w.db.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
    const first = await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    assert.equal(first.updated.length, 1);
    assert.equal(first.later.length, 2);
    assert.match((await w.db.repos(5))[0].error, /ran out of time/);
    await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    const last = await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    assert.equal(last.later, undefined);
    assert.equal((await w.db.runs(5, 70)).filter((r) => r.state).length, 3);
  } finally { await w.close(); }
});

test('a job that waited past the token\'s reuse window mints a fresh token', async () => {
  let clock = 10 * TOKEN_REUSE_MS;
  const w = await bare({ now: () => clock });
  try {
    const used = [];
    const r0 = w.gh.ref.bind(w.gh);
    w.gh.ref = async (token, ...a) => { used.push(token); return r0(token, ...a); };
    w.gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: makeRun('r1') }) });
    await w.db.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
    await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' }, { token: 'fresh', tokenAt: clock - 1000 });
    assert.equal(used.at(-1), 'fresh');
    await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' }, { token: 'stale', tokenAt: clock - TOKEN_REUSE_MS - 1 });
    assert.equal(used.at(-1), 'inst-5', 'an old token is replaced');
  } finally { await w.close(); }
});

test('blobs are charged at what reading them holds (BLOB_HOLD times their size)', async () => {
  const w = await bare();
  try {
    const log = makeRun('r1');
    w.gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: log }) });
    await w.db.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
    await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    assert.equal(w.ingest.stats().blobBytes.peak, log.length * BLOB_HOLD);
  } finally { await w.close(); }
});

test('uninstall: queued syncs are dropped and running ones write nothing more', { timeout: 60_000 }, async () => {
  const g = gate(); let inTree = 0;
  const gh = fakeGitHub();
  const t0 = gh.tree.bind(gh);
  gh.tree = async (...a) => { inTree++; await g.wait(); return t0(...a); };
  const t = await startApp({ gh });
  const log = plainRun();
  const guarded = guardTimer(g);
  try {
    await t.db.upsertInstallation({ id: 5, account: 'acme' });
    const jobs = [];
    for (let k = 0; k < 4; k++) {
      gh.addRepo(`acme/r${k}`, { id: 70 + k, installationId: 5, files: stateFiles({ r1: log }) });
      await t.db.upsertRepo({ installationId: 5, id: 70 + k, fullName: `acme/r${k}` });
      jobs.push(t.app.ingest.syncRepo(5, { id: 70 + k, fullName: `acme/r${k}` }).then((r) => r, (e) => ({ refused: e.message })));
    }
    await until(() => inTree === 2, guarded); // two running (SYNC_PER_INSTALLATION), two queued
    const [code] = await hook(t, 'installation', { action: 'deleted', installation: { id: 5, account: { login: 'acme' } }, sender: { login: 'acme' } });
    assert.equal(code, 200);
    g.open();
    const out = await Promise.all(jobs);
    assert.deepEqual(out.map((r) => (r.refused ? 'refused' : r.removed ? 'removed' : 'synced')), ['removed', 'removed', 'refused', 'refused']);
    assert.match(out[2].refused, /removed/);
    assert.equal(inTree, 2, 'the queued ones never read');
    assert.deepEqual(await t.db.repos(5), []);
    for (let k = 0; k < 4; k++) assert.deepEqual(await t.db.runs(5, 70 + k), []);
    assert.equal(guarded.fired, false);
  } finally { clearTimeout(guarded.timer); g.open(); await t.close(); }
});

test('a sync for an installation that is gone (another process removed it) writes nothing', async () => {
  const w = await bare();
  try {
    w.gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: makeRun('r1') }) });
    await w.db.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
    await w.db.deleteInstallation(5);
    const r = await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    assert.equal(r.removed, true);
    assert.equal(w.gh.count('ref'), 0);
    assert.deepEqual(await w.db.runs(5, 70), []);
  } finally { await w.close(); }
});

test('resyncAll takes installations in turn: one with many repos does not stand in front of another', { timeout: 60_000 }, async () => {
  const g = gate();
  const gh = fakeGitHub();
  const t0 = gh.tree.bind(gh);
  gh.tree = async (token, full, ...a) => { if (full.startsWith('big/')) await g.wait(); return t0(token, full, ...a); };
  const t = await startApp({ gh });
  const log = plainRun();
  const guarded = guardTimer(g);
  try {
    await t.db.upsertInstallation({ id: 1, account: 'big' });
    await t.db.upsertInstallation({ id: 2, account: 'small' });
    for (let k = 0; k < 6; k++) gh.addRepo(`big/r${k}`, { id: 100 + k, installationId: 1, files: stateFiles({ r1: log }) });
    gh.addRepo('small/web', { id: 200, installationId: 2, files: stateFiles({ r1: log }) });
    const pass = t.app.resyncAll();
    await until(async () => (await t.db.run(2, 200, 'r1'))?.state, guarded);
    assert.equal(guarded.fired, false, 'the small installation synced while the big one\'s syncs were held');
    g.open();
    const out = await pass;
    assert.equal(out.length, 2);
    assert.equal(out.find((x) => x.installation === 1).repos.length, 6);
  } finally { clearTimeout(guarded.timer); g.open(); await t.close(); }
});

test('webhook budget: from GitHub\'s addresses, a hook that does not name this App is capped per hook target and kept out of the reserve', () => {
  const b = webhookBudget({ max: 1000, perGroup: 100, reserve: 400 });
  const other = (id) => ({ group: `hook:repository:${id}`, github: true, ours: false });
  const ours = { group: '140.82.115.0/24', github: true, ours: true };
  assert.equal(b.refusal(other(1), 150)?.status, 413, 'larger than one target\'s share');
  const a = b.open(other(1), 100); assert.equal(a.add(100), null);
  const refused = b.open(other(1), 10);
  assert.equal(refused.add(10)?.status, 429, 'one target holds at most its share');
  refused.release(); // as readBody does when it refuses
  for (let id = 2; id <= 6; id++) assert.equal(b.open(other(id), 100).add(100), null);
  assert.equal(b.refusal(other(7), 100)?.status, 503, 'the others together stop short of the reserve');
  assert.equal(b.refusal(ours, 400), null, 'this App\'s own deliveries still have the reserve');
  assert.equal(b.refusal({ group: 'x', github: true }, 400), null, 'a source with no claim either way is GitHub as before');
});

test('an unchanged repo with nothing owed does not touch the trail lane', async () => {
  const refreshed = [];
  const w = await bare({ trail: { async refreshRun(i, repo, runId) { refreshed.push(runId); return { comments: [], board: [] }; } } });
  try {
    w.gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: makeRun('r1') }) });
    await w.db.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
    await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    await tick();
    const r = await w.ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    assert.equal(r.unchanged, true);
    assert.deepEqual(refreshed, ['r1'], 'refreshed once, when it changed');
    assert.equal(w.ingest.stats().trail.peak, 1);
  } finally { await w.close(); }
});

// #42 (round 5's t1 proof): a refresh charges every comment page it reads, searches at most
// CAPS.searchPages of them, and stops at its own read cap, so a flood of fresh trackers holds a lane
// slot for a few reads, not for hours. Each issue already holds 300 comments that are not ours.
test('t1: a victim\'s tracker comment is written after a few attacker reads, not after their whole refreshes', { timeout: 600_000 }, async () => {
  const g = gate(); const order = [];
  const gh = fakeGitHub();
  const i0 = gh.issueComments.bind(gh);
  gh.issueComments = (token, full, n, opts = {}) => (async function* () {
    if (full.startsWith('m')) await g.wait();
    yield* i0(token, full, n, { ...opts, spend: () => { opts.spend?.(); order.push(full.startsWith('m') ? 'a' : 'v'); } });
  })();
  const c0 = gh.createComment.bind(gh);
  gh.createComment = async (t, full, ...a) => { if (full === 'v/web') order.push('V'); return c0(t, full, ...a); };
  const t = await startApp({ gh, over: { trailRefreshReads: 6 } });
  const guarded = guardTimer(g, 540_000); // a hang guard only: full-suite load must never fire it
  try {
    const attackers = [];
    for (const inst of [60, 61, 62, 63]) {
      const full = `m${inst}/r0`;
      await t.db.upsertInstallation({ id: inst, account: `m${inst}` });
      gh.addRepo(full, { id: inst * 100, installationId: inst, files: stateFiles({ a1: refsRun('a1', full) }) });
      await t.db.upsertRepo({ installationId: inst, id: inst * 100, fullName: full, private: true });
      for (let n = 1; n <= 10; n++) gh.comments.set(`${full}#${n}`, Array.from({ length: 300 }, (_, i) => ({ id: inst * 10_000 + n * 1000 + i, body: 'not ours', performed_via_github_app: null })));
      attackers.push(t.app.ingest.syncRepo(inst, { id: inst * 100, fullName: full }));
    }
    await until(() => t.app.ingest.stats().trail.running === 4, guarded); // every lane slot held by an attacker
    await t.db.upsertInstallation({ id: 9, account: 'victim' });
    gh.addRepo('v/web', { id: 900, installationId: 9, files: stateFiles({ r1: makeRun('r1', { issues: ['v/web#1'] }) }) });
    await t.db.upsertRepo({ installationId: 9, id: 900, fullName: 'v/web', private: true });
    const victim = t.app.ingest.syncRepo(9, { id: 900, fullName: 'v/web' });
    await until(() => t.app.ingest.stats().trail.queued === 1, guarded);
    g.open();
    assert.deepEqual((await victim).updated, ['r1']);
    const before = order.indexOf('V');
    assert.ok(before > 0, 'the victim\'s tracker comment was posted');
    const attackerReads = order.slice(0, before).filter((x) => x === 'a').length;
    assert.ok(attackerReads <= 4 * 6, `attackers read ${attackerReads} pages before the victim's comment (at most 6 per refresh)`);
    for (const a of await Promise.all(attackers)) assert.deepEqual(a.updated, ['a1']);
    for (const inst of [60, 61, 62, 63]) assert.equal((await t.db.run(inst, inst * 100, 'a1')).trailPending, true, 'each attacker refresh stopped at its cap and stays owed');
    assert.ok(gh.count('commentPage') <= 4 * 6 + 1);
    assert.equal(guarded.fired, false);
  } finally { clearTimeout(guarded.timer); g.open(); await t.close(); }
});

test('#42: a known comment id is edited without a search; a deleted one is re-posted without a search', async () => {
  const t = await startApp();
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { issues: ['acme/web#1'] }) }) });
    await t.db.upsertInstallation({ id: 7, account: 'acme' });
    await t.app.ingest.syncInstallation(7);
    assert.equal(t.gh.count('commentPage'), 1, 'one search, for the first comment');
    const id = (await t.db.tracker(7, 'acme/web#1', 'r1', 'u1')).commentId;
    await t.gh.deleteComment('x', 'acme/web', id);
    await t.db.putTracker(7, { refKey: 'acme/web#1', runId: 'r1', unitId: 'u1', commentId: id, bodySha: 'stale' });
    await t.app.ingest.syncInstallation(7, { force: true });
    assert.equal(t.gh.count('commentPage'), 1, 'no search when the id is known');
    assert.equal(t.gh.count('createComment'), 2);
    assert.notEqual((await t.db.tracker(7, 'acme/web#1', 'r1', 'u1')).commentId, id);
  } finally { await t.close(); }
});

test('#42: a trail refresh stops at the job\'s time limit between refs, and the run stays owed', async () => {
  let clock = 0;
  const gh = fakeGitHub();
  const db0 = guard(memoryDb());
  const tr = trail({ db: db0, gh, config: { github: { appId: 1 }, baseUrl: 'http://x' }, now: () => clock });
  const c0 = gh.createComment.bind(gh);
  gh.createComment = async (...a) => { clock += 600; return c0(...a); };
  await db0.upsertInstallation({ id: 5, account: 'acme' });
  const ingest = ingester({ db: db0, gh, log: null, trail: tr, limits: { jobMs: 1000 }, now: () => clock });
  try {
    gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: refsRun('r1', 'acme/web') }) });
    await db0.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
    await ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    assert.equal(gh.count('createComment'), 2, 'the third ref found the job out of time');
    assert.equal((await db0.run(5, 70, 'r1')).trailPending, true);
    for (let k = 0; k < 10 && (await db0.run(5, 70, 'r1')).trailPending; k++) await ingest.syncRepo(5, { id: 70, fullName: 'acme/web' }, { force: true });
    assert.equal(gh.count('createComment'), 10, 'later syncs finish it, one comment per ref');
    assert.equal((await db0.run(5, 70, 'r1')).trailPending, false);
  } finally { await ingest.close(); await db0.close(); }
});

test('#42: a refresh stops writing once the installation is removed', async () => {
  const gh = fakeGitHub();
  const db0 = guard(memoryDb());
  let gone = false;
  const tr = trail({ db: db0, gh, config: { github: { appId: 1 }, baseUrl: 'http://x' } });
  const c0 = gh.createComment.bind(gh);
  gh.createComment = async (...a) => { gone = true; return c0(...a); };
  await db0.upsertInstallation({ id: 5, account: 'acme' });
  gh.addRepo('acme/web', { id: 70, installationId: 5, files: stateFiles({ r1: refsRun('r1', 'acme/web') }) });
  await db0.upsertRepo({ installationId: 5, id: 70, fullName: 'acme/web' });
  const ingest = ingester({ db: db0, gh, log: null, trail: null });
  try {
    await ingest.syncRepo(5, { id: 70, fullName: 'acme/web' });
    const repo = (await db0.repos(5))[0];
    const r = await tr.refreshRun(5, repo, 'r1', { gone: () => gone });
    assert.equal(r.removed, true);
    assert.equal(gh.count('createComment'), 1);
  } finally { await ingest.close(); await db0.close(); }
});
