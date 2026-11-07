// Round 5 of the c11 review: trail refreshes of one repo never overlap, and a clean refresh never
// wipes a deferral recorded by another one. Also: a link resolves to this installation's repo row only.
// Runs on Postgres too when TEST_DATABASE_URL is set (helpers.mjs).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { CAPS } from '../src/trail.mjs';
import { makeRun, startApp, stateFiles } from './helpers.mjs';

const PR = 'https://github.com/acme/web/pull/12';
const MOBILE_PR = 'https://github.com/acme/mobile/pull/5';
// A promise and the function that settles it: the tests force each interleaving with these, never a sleep.
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return Object.assign(p, { open }); };

async function world() {
  let clock = Date.parse('2026-11-06T12:00:00Z');
  const t = await startApp({ now: () => clock });
  t.tick = (ms) => { clock += ms; };
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { prs: [MOBILE_PR, PR] }) }, { repos: ['acme/mobile'] }) });
  t.gh.addRepo('acme/mobile', { id: 71, installationId: 7, defaultFiles: { 'coordinator.json': { primary: 'acme/web' } } });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  t.send = (event, payload, delivery) => {
    const body = JSON.stringify(payload);
    return fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(body).digest('hex')}` } });
  };
  t.body = (k) => (t.gh.comments.get(k) ?? []).map((c) => c.body).join('\n');
  t.pending = async () => (await t.db.runs(7, 70))[0].trailPending;
  // web#12's comment edit is held until the test lets it go (`t.release()`), so a second refresh is
  // sure to arrive while it is in flight; `t.writing` settles when the held edit has started, and
  // `overlap` records any comment write that starts while another is still running.
  t.slowWeb = () => {
    const orig = t.gh.updateComment;
    const held = gate(); t.writing = gate(); t.release = held.open;
    let inFlight = 0; t.overlap = 0;
    t.gh.updateComment = async (tok, full, ...a) => {
      if (inFlight++) t.overlap++;
      try { if (full === 'acme/web') { t.writing.open(); await held; } return await orig(tok, full, ...a); } finally { inFlight--; }
    };
    return () => { t.gh.updateComment = orig; };
  };
  // Settles once a webhook's refresh has joined the repo's queue (ingest.refreshRuns queues it at once).
  t.queued = () => {
    const orig = t.app.ingest.refreshRuns; const joined = gate();
    t.app.ingest.refreshRuns = (...a) => { const p = orig(...a); joined.open(); t.app.ingest.refreshRuns = orig; return p; };
    return joined;
  };
  // While web#12's edit is held: send a webhook, wait until its refresh is queued behind the held one, then let the edit go.
  t.sendWhileWriting = async (event, payload, delivery) => {
    await t.writing;
    const joined = t.queued();
    assert.equal((await t.send(event, payload, delivery)).status, 202);
    await joined;
    t.release();
  };
  return t;
}
const mergedWeb = { action: 'closed', installation: { id: 7 }, repository: { id: 70, full_name: 'acme/web', private: true }, pull_request: { number: 12, merged: true, merged_at: '2026-11-06T11:01:00Z' } };
const mobileChecks = { action: 'completed', installation: { id: 7 }, repository: { id: 71, full_name: 'acme/mobile', private: true }, check_suite: { id: 9, conclusion: 'success', updated_at: '2026-11-06T11:02:00Z', pull_requests: [{ number: 5 }] } };

async function capped(fn) {
  const keep = CAPS.commentWritesPerInstallation;
  CAPS.commentWritesPerInstallation = 1;
  try { await fn(); } finally { CAPS.commentWritesPerInstallation = keep; }
}

test('a webhook refresh deferred while an owed run is being retrailed keeps its flag, and its line lands later', () => capped(async () => {
  const t = await world();
  try {
    await t.app.resyncAll(); t.tick(CAPS.windowMs + 1); await t.app.resyncAll(); t.tick(CAPS.windowMs + 1);
    // Use up the window on mobile#5, so web#12's merge is held back and the run is owed.
    await t.send('pull_request', { action: 'reopened', installation: { id: 7 }, repository: { id: 71, full_name: 'acme/mobile', private: true }, pull_request: { number: 5, updated_at: '2026-11-06T11:00:00Z' } }, 'x1'); await t.app.idle();
    await t.send('pull_request', mergedWeb, 'x2'); await t.app.idle();
    assert.equal(await t.pending(), true);
    t.tick(CAPS.windowMs + 1);
    const restore = t.slowWeb();
    const resync = t.app.resyncAll(); // retrails the owed run; its web#12 edit is held
    await t.sendWhileWriting('check_suite', mobileChecks, 'x3'); // its refresh waits in the queue, then is over budget
    await resync; await t.app.idle(); restore();
    assert.equal(t.overlap, 0, 'no two refreshes of the repo ran at once');
    assert.match(t.body('acme/web#12'), /merged/);
    assert.doesNotMatch(t.body('acme/mobile#5'), /checks passed/, 'held back by the write budget');
    assert.equal(await t.pending(), true, 'the deferral is not wiped by the retrail finishing cleanly');
    for (let i = 0; i < 2; i++) { t.tick(CAPS.windowMs + 1); await t.app.resyncAll(); }
    assert.match(t.body('acme/mobile#5'), /checks passed/, 'the held-back line lands at a later resync');
    assert.equal(await t.pending(), false);
    assert.deepEqual([t.gh.comments.get('acme/web#12').length, t.gh.comments.get('acme/mobile#5').length], [1, 1], 'edited, never posted twice');
  } finally { await t.close(); }
}));

test('two overlapping webhooks: the second waits for the first, and its deferral survives', () => capped(async () => {
  const t = await world();
  try {
    await t.app.resyncAll(); t.tick(CAPS.windowMs + 1); await t.app.resyncAll(); t.tick(CAPS.windowMs + 1);
    assert.equal(await t.pending(), false);
    const restore = t.slowWeb();
    const first = t.send('pull_request', mergedWeb, 'y1');
    await t.sendWhileWriting('check_suite', mobileChecks, 'y2');
    await first; await t.app.idle(); restore();
    assert.equal(t.overlap, 0, 'no two refreshes of the repo ran at once');
    assert.equal(await t.pending(), true, 'the second refresh was over budget: still owed');
    for (let i = 0; i < 2; i++) { t.tick(CAPS.windowMs + 1); await t.app.resyncAll(); }
    assert.match(t.body('acme/mobile#5'), /checks passed/);
    assert.equal(await t.pending(), false);
  } finally { await t.close(); }
}));

test('a webhook refresh that hits a GitHub 5xx while another is mid-write keeps its flag', async () => {
  const t = await world();
  try {
    await t.app.resyncAll(); t.tick(CAPS.windowMs + 1); await t.app.resyncAll(); t.tick(CAPS.windowMs + 1);
    const restore = t.slowWeb();
    const slow = t.gh.updateComment; let fail = 1;
    t.gh.updateComment = async (tok, full, ...a) => {
      if (full === 'acme/mobile' && fail-- > 0) throw Object.assign(new Error('GitHub 502'), { status: 502 });
      return slow(tok, full, ...a);
    };
    const first = t.send('pull_request', mergedWeb, 'z1');
    await t.sendWhileWriting('check_suite', mobileChecks, 'z2');
    await first; await t.app.idle(); restore();
    assert.equal(await t.pending(), true, 'the failed write is still owed');
    t.tick(60_000); await t.app.resyncAll();
    assert.match(t.body('acme/mobile#5'), /checks passed/);
    assert.equal(await t.pending(), false);
  } finally { await t.close(); }
});

test('a clean retrail clears the flag only if no deferral was recorded since it read it', async () => {
  const t = await world();
  try {
    await t.app.resyncAll();
    await t.db.markTrailPending(7, 70, 'r1');
    const seen = (await t.db.runs(7, 70))[0].trailSeq;
    await t.db.markTrailPending(7, 70, 'r1'); // another refresh (or process) defers meanwhile
    assert.equal(await t.db.clearTrailPending(7, 70, 'r1', seen), false, 'a stale clear is refused');
    assert.equal(await t.pending(), true);
    const now = (await t.db.runs(7, 70))[0].trailSeq;
    assert.ok(now > seen, 'every mark takes a new, higher value');
    assert.equal(await t.db.clearTrailPending(7, 70, 'r1', now), true);
    assert.equal(await t.pending(), false);
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' }, { force: true }); // a refresh marks first, then clears its own mark
    assert.ok((await t.db.runs(7, 70))[0].trailSeq > now);
    assert.equal(await t.pending(), false);
  } finally { await t.close(); }
});

test('a link resolves to this installation\'s repo row, never a same-named one in another installation', async () => {
  const t = await world();
  try {
    await t.db.upsertRepo({ installationId: 7, id: 70, fullName: 'acme/web', private: true });
    await t.db.upsertRepo({ installationId: 7, id: 71, fullName: 'acme/mobile', private: true });
    // Another installation holds a row of the same name, synced more recently.
    await t.db.upsertInstallation({ id: 8, account: 'acme-old' });
    await t.db.upsertRepo({ installationId: 8, id: 81, fullName: 'ACME/Mobile' });
    await t.db.setRepoSync(8, 81, { headSha: 'h' });
    assert.equal((await t.db.repoByName(7, 'acme/mobile')).id, 71);
    assert.equal((await t.db.repoByName(8, 'acme/mobile')).id, 81);
    assert.equal(await t.db.repoByName(9, 'acme/mobile'), null);
    assert.throws(() => t.db.repoByName(undefined, 'acme/mobile'), /installation id is required/);
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
    assert.equal(t.gh.comments.get('acme/mobile#5')?.length, 1, 'the fence saw installation 7\'s row and let the comment through');
  } finally { await t.close(); }
});

// c11 final critic follow-ups.
test('a refresh marks the run owed before it starts: a crash mid-refresh leaves the write owed', async () => {
  const t = await world();
  try {
    await t.app.resyncAll();
    assert.equal(await t.pending(), false);
    let seenDuring = null;
    const orig = t.gh.updateComment;
    t.gh.updateComment = async (...a) => { seenDuring ??= await t.pending(); throw new Error('the process dies here'); };
    await t.send('pull_request', mergedWeb, 'crash1'); await t.app.idle();
    t.gh.updateComment = orig;
    assert.equal(seenDuring, true, 'owed while the refresh runs');
    assert.equal(await t.pending(), true, 'still owed after the crash');
    t.tick(60_000); await t.app.resyncAll();
    assert.equal(await t.pending(), false, 'a clean retry clears it');
    assert.match(t.body('acme/web#12'), /merged/i);
  } finally { await t.close(); }
});

test('trail_seq is global: a run dropped and re-created never gets back a value a refresh read (no ABA)', async () => {
  const t = await world();
  try {
    await t.app.resyncAll();
    const before = await t.db.markTrailPending(7, 70, 'r1');
    const row = (await t.db.runs(7, 70))[0];
    await t.db.dropRunsExcept(7, 70, []);
    await t.db.putRun(7, 70, { runId: 'r1', eventsSha: row.eventsSha, seq: row.seq, state: row.state, error: null });
    const after = await t.db.markTrailPending(7, 70, 'r1');
    assert.notEqual(after, before);
    assert.equal(await t.db.clearTrailPending(7, 70, 'r1', before), false, 'the stale value matches nothing');
    assert.equal(await t.pending(), true);
    assert.equal(await t.db.markTrailPending(7, 70, 'nope'), null, 'no such run');
  } finally { await t.close(); }
});

test('a page resolves to the row whose id GitHub gives, not a stale same-named row in another installation', async () => {
  const t = await world();
  try {
    await t.app.resyncAll();
    t.gh.addUser('tok-r', { id: 4, login: 'r', read: ['acme/web'] });
    // A stale row of the same name (a repo since deleted and re-made, or moved) synced more recently elsewhere.
    await t.db.upsertInstallation({ id: 8, account: 'acme-old' });
    await t.db.upsertRepo({ installationId: 8, id: 99, fullName: 'acme/web' });
    await t.db.setRepoSync(8, 99, { headSha: 'h' });
    const { signIn } = await import('./helpers.mjs');
    const cookie = await signIn(t, 'r');
    for (let i = 0; i < 2; i++) { // the second read comes from the cache
      const r = await fetch(`${t.base}/r/acme/web/run/r1`, { headers: { Cookie: cookie } });
      assert.equal(r.status, 200, `read ${i + 1}`);
    }
    assert.equal(t.gh.calls.filter((c) => c[0] === 'repoAccess').length, 1);
  } finally { await t.close(); }
});
