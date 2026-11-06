// c14: the security critic's proofs (p1-p4) as tests, for a service hosted for many tenants.
// Each test names the proof it comes from and the behaviour that now holds.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { test } from 'node:test';
import { CONFIRMS_PER_DAY } from '../src/alerts/routes.mjs';
import { COMMANDS_PER_HOUR, commands as makeCommands } from '../src/commands.mjs';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { silent } from '../src/log.mjs';
import { parser } from '../src/parser.mjs';
import { appendEvent, makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
let deliveries = 0;
const hook = (t, event, body) => {
  const b = JSON.stringify(body);
  return fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': `h-${++deliveries}`, 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, b) } });
};
function fakeSenders() {
  const sent = { email: [], push: [], github: [] };
  return {
    sent,
    email: { async send(m) { sent.email.push(m); } },
    push: { publicKey: 'k', async send(s, m) { sent.push.push(m); return 'sent'; } },
    github: { async send(...a) { sent.github.push(a); } },
  };
}
const csrfOf = async (t, cookie) => /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${t.base}/alerts`, { headers: { Cookie: cookie } })).text())[1];
const poster = (t, cookie) => (path, f) => fetch(`${t.base}${path}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(f), headers: { Cookie: cookie, Origin: t.cfg.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' } });

// p1: one tenant's run log froze the whole service (catastrophic backtracking in secret masking).
test('p1: a run log built to make masking backtrack is synced quickly, and the server keeps answering meanwhile', async () => {
  const t = await startApp();
  try {
    const evil = 'token_'.repeat(5000);
    const log = appendEvent(makeRun('r1'), 'state.edited', { ops: [{ op: 'set', path: ['goal'], value: evil }, { op: 'set', path: ['fence'], value: 'token='.repeat(5000) }] });
    t.gh.addRepo('mallory/own', { id: 99, installationId: 66, files: stateFiles({ r1: log }) });
    let worst = 0; let stop = false;
    const probe = (async () => { while (!stop) { const h = performance.now(); await fetch(`${t.base}/healthz`); worst = Math.max(worst, performance.now() - h); await new Promise((r) => setTimeout(r, 10)); } })();
    const a = performance.now();
    assert.equal((await hook(t, 'installation', { action: 'created', installation: { id: 66, account: { login: 'mallory' } } })).status, 202);
    await new Promise((r) => setTimeout(r, 50));
    await t.app.idle(); stop = true; await probe;
    const took = performance.now() - a;
    const run = await t.db.run(66, 99, 'r1');
    assert.equal(run.error, null);
    assert.equal(run.state.goal.length, evil.length, 'read and stored, nothing to mask');
    assert.ok(took < 5000, `the sync took ${Math.round(took)} ms`);
    assert.ok(worst < 1000, `/healthz waited ${Math.round(worst)} ms`);
  } finally { await t.close(); }
});

test('p1: a string longer than the event schema allows is refused with a reason, and the last good state stays', async () => {
  const t = await startApp();
  try {
    const good = makeRun('r1');
    t.gh.addRepo('mallory/own', { id: 99, installationId: 66, files: stateFiles({ r1: good }) });
    await t.db.upsertInstallation({ id: 66, account: 'mallory' });
    await t.app.ingest.syncInstallation(66);
    t.gh.setFiles('mallory/own', stateFiles({ r1: appendEvent(good, 'state.edited', { ops: [{ op: 'set', path: ['goal'], value: 'x'.repeat(70_000) }] }) }));
    await t.app.ingest.syncInstallation(66);
    const run = await t.db.run(66, 99, 'r1');
    assert.match(run.error, /longer than 65536/);
    assert.equal(run.seq, 7, 'the last good state is kept');
  } finally { await t.close(); }
});

test('p1: reading runs in a worker; one that runs past its time limit is an error, and the next read gets a fresh worker', async () => {
  const log = makeRun('r1');
  const slow = parser({ timeoutMs: 1 });
  try { assert.match((await slow.readLog('r1', log)).error, /took longer than/); } finally { await slow.close(); }
  const p = parser();
  try {
    assert.equal((await p.readLog('r1', log)).seq, 7);
    assert.match((await p.readLog('r1', Buffer.from('{"bad"'))).error, /line 1/);
    assert.deepEqual((await p.readJson('lessons', Buffer.from('[{"text":"DB_PASSWORD=SuperSecret99"}, 3]'))).value, [{ text: '[redacted]' }]);
    assert.match((await p.readJson('config', Buffer.from('{'))).error, /JSON/);
  } finally { await p.close(); }
});

// p2.1: one account could make the service send any number of confirmation emails to any addresses.
test('p2: confirmation email is limited per person and per address', async () => {
  const senders = fakeSenders();
  const t = await startApp({ senders });
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
    t.gh.addUser('tok-ana', { id: 1, login: 'ana', read: ['acme/web'] });
    t.gh.addUser('tok-bo', { id: 2, login: 'bo', read: ['acme/web'] });
    await t.db.upsertInstallation({ id: 7, account: 'acme' });
    const ana = await signIn(t, 'ana');
    const post = poster(t, ana); const csrf = await csrfOf(t, ana);
    let last;
    for (let i = 0; i < 40; i++) last = await post('/alerts/settings', { csrf, email: `victim${i % 2}@example.org`, tz: 'UTC' });
    assert.equal(senders.sent.email.length, CONFIRMS_PER_DAY, 'per person');
    assert.match(await last.text(), /Too many confirmation emails today/);
    // ana's three went to victim0, victim1, victim0: victim0 has one left for today, whoever asks and however it is spelt.
    const bo = await signIn(t, 'bo');
    const asBo = async (email) => (await poster(t, bo)('/alerts/settings', { csrf: await csrfOf(t, bo), email, tz: 'UTC' })).text();
    await asBo('Victim0@example.org');
    await asBo('victim9@example.org');
    assert.match(await asBo('VICTIM0@example.org'), /Too many confirmation emails today/);
    assert.deepEqual(senders.sent.email.slice(CONFIRMS_PER_DAY).map((m) => m.to), ['Victim0@example.org', 'victim9@example.org'], 'per address, across people and letter case');
  } finally { await t.close(); }
});

// p2.2 and the hardening list: an uninstall left alert rows (and digests) behind.
test('p2: an uninstall leaves no row about the installation in any table, but the one audit row saying so', async () => {
  const senders = fakeSenders();
  let clock = Date.now();
  const t = await startApp({ senders, now: () => clock });
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { issues: ['acme/web#12'] }) }) });
    t.gh.addRepo('other/app', { id: 80, installationId: 8, files: stateFiles({ r1: makeRun('r1') }) });
    t.gh.addUser('tok-ana', { id: 1, login: 'ana', read: ['acme/web', 'other/app'] });
    for (const [id, account] of [[7, 'acme'], [8, 'other']]) { await t.db.upsertInstallation({ id, account }); await t.app.ingest.syncInstallation(id); }
    const store = t.app.alerts.store;
    await store.putSettings(1, 'ana', { email: 'ana@example.com', quiet: { start: 0, end: 23 }, tz: 'UTC' });
    for (const [inst, repo] of [[7, 70], [8, 80]]) await store.subscribe(1, 'ana', inst, repo, clock);
    await t.app.alerts.dispatch(7, (await t.db.repos(7))[0], { runId: 'r1', trigger: 'run-finished' }); // queued for the digest
    await t.app.alerts.dispatch(7, (await t.db.repos(7))[0], { runId: 'r1', trigger: 'security', key: 'secret:1', once: true }); // sent
    await t.app.alerts.dispatch(8, (await t.db.repos(8))[0], { runId: 'r1', trigger: 'security', key: 'secret:1', once: true });
    await t.db.addGhEvent(7, { id: 'e1', refKey: 'acme/web#12', kind: 'merged', at: new Date().toISOString(), detail: {} });
    await t.db.putTracker(7, { refKey: 'acme/web#12', runId: 'r1', unitId: 'u1', commentId: 5 });
    await t.db.claimCommand(7, 123);
    await t.db.audit('alerts.watch', { installationId: 7, login: 'ana' });
    const ac = new AbortController();
    const tok = await (await fetch(`${t.base}/doorbell/token?repo=acme/web`, { method: 'POST', headers: { Authorization: 'Bearer tok-ana' } })).json();
    const bell = await fetch(`${t.base}/doorbell`, { headers: { Authorization: `Bearer ${tok.token}` }, signal: ac.signal });
    assert.equal(bell.status, 200);
    assert.equal((await store.alertsFor(1)).filter((a) => a.installationId === 7).length, 2);

    assert.equal((await hook(t, 'installation', { action: 'deleted', installation: { id: 7, account: { login: 'acme' } }, sender: { login: 'acme-owner' } })).status, 200);
    assert.equal(t.app.doorbell.size(), 0, 'its doorbell listeners are closed');
    ac.abort();
    assert.deepEqual((await store.alertsFor(1)).map((a) => a.installationId), [8], 'sent and queued alerts gone; the other installation untouched');
    assert.deepEqual((await store.subscriptions(1)).map((s) => s.installationId), [8]);
    if (t.db.kind === 'postgres') {
      // Every table that has an installation_id column, so a new table cannot be forgotten.
      const tables = (await t.db.pool.query("SELECT table_name FROM information_schema.columns WHERE column_name = 'installation_id' AND table_schema = current_schema() ORDER BY 1")).rows.map((r) => r.table_name);
      assert.deepEqual(tables, ['alert_subscriptions', 'alerts', 'audit', 'comment_commands', 'gh_events', 'repos', 'runs', 'trackers', 'unit_refs']);
      for (const table of tables) {
        const rows = (await t.db.pool.query(`SELECT ${table === 'audit' ? 'kind' : "'' AS kind"} FROM ${table} WHERE installation_id = 7`)).rows.map((r) => r.kind);
        assert.deepEqual(rows, table === 'audit' ? ['installation.deleted'] : [], table);
        if (table !== 'audit') assert.ok((await t.db.pool.query(`SELECT 1 FROM ${table} WHERE installation_id = 8`)).rowCount > 0 || ['comment_commands', 'gh_events', 'trackers', 'unit_refs'].includes(table), `${table}: installation 8 kept`);
      }
      assert.equal((await t.db.pool.query('SELECT 1 FROM installations WHERE id = 7')).rowCount, 0);
    } else {
      assert.deepEqual(store.rows(7), { alerts: 0, subscriptions: 0 });
      assert.deepEqual(t.db.auditLog().filter((a) => a.installationId === 7).map((a) => a.kind), ['installation.deleted']);
      assert.deepEqual([await t.db.repos(7), await t.db.ghEvents(7, ['acme/web#12']), await t.db.tracker(7, 'acme/web#12', 'r1', 'u1'), await t.db.claimCommand(7, 123)], [[], [], null, true]);
    }
  } finally { await t.close(); }
});

// p2.3: a doorbell token kept working for 14 minutes after read access was revoked.
test('p2: the doorbell checks access when a stream opens and every recheck interval', async () => {
  let clock = Date.now();
  const t = await startApp({ now: () => clock, over: { doorbellRecheckMs: 150 } });
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
    t.gh.addUser('tok-ana', { id: 1, login: 'ana', read: ['acme/web'] });
    await t.db.upsertInstallation({ id: 7, account: 'acme' }); await t.app.ingest.syncInstallation(7);
    const mint = async () => (await (await fetch(`${t.base}/doorbell/token?repo=acme/web`, { method: 'POST', headers: { Authorization: 'Bearer tok-ana' } })).json()).token;
    const open = (tok) => fetch(`${t.base}/doorbell?run=r1`, { headers: { Authorization: `Bearer ${tok}` } });
    const live = await open(await mint());
    assert.equal(live.status, 200);
    const later = await mint();
    t.gh.revoke('tok-ana', 'acme/web');
    clock += 200; // past the cached answer
    const body = await live.text(); // the open stream ends at the next recheck
    assert.match(body, /event: expired/);
    clock += 14 * 60_000 - 200;
    const r = await open(later);
    assert.equal(r.status, 401, 'a token minted before the revocation opens nothing');
    assert.match((await r.json()).error, /no longer read/);
  } finally { t.app.doorbell.close(); await t.close(); }
});

// p2.4: a multibyte CSRF token or doorbell signature of the right length threw (500) instead of being refused.
test('p2: multibyte tokens are refused, never a server error', async () => {
  const t = await startApp();
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
    t.gh.addUser('tok-ana', { id: 1, login: 'ana', read: ['acme/web'] });
    await t.db.upsertInstallation({ id: 7, account: 'acme' }); await t.app.ingest.syncInstallation(7);
    const cookie = await signIn(t, 'ana');
    const csrf = await csrfOf(t, cookie);
    const r = await poster(t, cookie)('/alerts/watch', { csrf: 'é'.repeat(csrf.length), repo: 'acme/web', on: '1' });
    assert.equal(r.status, 403);
    const tok = (await (await fetch(`${t.base}/doorbell/token?repo=acme/web`, { method: 'POST', headers: { Authorization: 'Bearer tok-ana' } })).json()).token;
    const [body, sig] = tok.split('.');
    const bad = await fetch(`${t.base}/doorbell`, { headers: { Authorization: `Bearer ${body}.${'é'.repeat(sig.length)}` } });
    assert.equal(bad.status, 401);
    const start = await fetch(`${t.base}/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const back = await fetch(`${t.base}/auth/callback?code=ana&state=${encodeURIComponent('é'.repeat(state.length))}`, { headers: { Cookie: start.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
    assert.equal(back.status, 400);
  } finally { await t.close(); }
});

// p3: unsigned 5 MB bodies were read in full before the failure limiter was consulted.
const unsigned = (port, body, headers = {}) => new Promise((ok) => {
  const r = request({ host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=00', 'Transfer-Encoding': 'chunked', ...headers } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
  r.on('error', () => ok('reset'));
  r.end(body);
});
test('p3: past the failure limit a body is not read; all bodies being read at once share one budget', async () => {
  const t = await startApp({ over: { webhookInflightBytes: 8 * 1024 * 1024 } });
  try {
    const port = new URL(t.base).port;
    for (let i = 0; i < 31; i++) await unsigned(port, '{}');
    const big = Buffer.alloc(5 * 1024 * 1024 - 10, 0x61);
    const peakBefore = t.app.webhookBytes().peak;
    assert.equal(await unsigned(port, '{}'), 429);
    const a = performance.now();
    assert.ok([429, 'reset'].includes(await unsigned(port, big)), 'answered 429 and closed while the client was still sending');
    assert.equal(t.app.webhookBytes().peak, peakBefore, 'answered without reading the body');
    assert.ok(performance.now() - a < 2000);
    const t2 = await startApp({ over: { webhookInflightBytes: 8 * 1024 * 1024 } });
    try {
      const codes = await Promise.all(Array.from({ length: 30 }, () => unsigned(new URL(t2.base).port, big)));
      const b = t2.app.webhookBytes();
      assert.ok(b.peak <= b.max + 1024 * 1024, `at most the budget (plus one chunk) was held at once: ${b.peak} of ${b.max}`);
      assert.ok(codes.some((c) => c === 503 || c === 'reset'), 'some were turned away for the budget');
      assert.ok(codes.every((c) => [401, 429, 503, 'reset'].includes(c)), String(codes));
      assert.equal(b.used, 0, 'every byte is released');
    } finally { await t2.close(); }
  } finally { await t.close(); }
});

// p4: a link scanner's GET confirmed someone else's address, and the victim had no way to stop the mail.
test('p4: opening the confirm link confirms nothing; every alert email has a signed one-click unsubscribe that needs no sign-in', async () => {
  const senders = fakeSenders();
  const t = await startApp({ senders });
  try {
    t.gh.addRepo('mallory/spam', { id: 80, installationId: 8, files: stateFiles({ r1: makeRun('r1', { goal: 'g' }) }) });
    t.gh.addUser('tok-m', { id: 5, login: 'mallory', read: ['mallory/spam'] });
    await t.db.upsertInstallation({ id: 8, account: 'mallory' }); await t.app.ingest.syncInstallation(8);
    const cookie = await signIn(t, 'm');
    const post = poster(t, cookie); const csrf = await csrfOf(t, cookie);
    await post('/alerts/settings', { csrf, email: 'ceo@victim.example', tz: 'UTC', ch_email: '1', include_text: '1' });
    await post('/alerts/watch', { csrf, repo: 'mallory/spam', on: '1' });
    const link = /Confirm: (\S+)/.exec(senders.sent.email[0].text)[1].replace(t.cfg.baseUrl, t.base);
    const scan = await fetch(link); // a mail scanner: no cookie, no click
    assert.equal(scan.status, 200);
    assert.doesNotMatch(await scan.text(), /Email confirmed/);
    await t.app.alerts.dispatch(8, (await t.db.repos(8))[0], { runId: 'r1', trigger: 'needs-you', question: 'URGENT: wire 40k today' });
    assert.equal(senders.sent.email.length, 1, 'nothing sent to an address nobody confirmed');

    // The owner confirms by pressing the button; then every alert email can stop itself.
    await fetch(`${t.base}/alerts/confirm`, { method: 'POST', body: new URLSearchParams({ t: new URL(link).searchParams.get('t') }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    await t.app.alerts.dispatch(8, (await t.db.repos(8))[0], { runId: 'r1', trigger: 'run-finished' });
    const m = senders.sent.email.at(-1);
    assert.equal(m.to, 'ceo@victim.example');
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const url = /^<(.+)>$/.exec(m.headers['List-Unsubscribe'])[1];
    assert.ok(m.text.includes(url), 'the same link is in the text');
    const local = url.replace(t.cfg.baseUrl, t.base);
    const forged = local.replace(/s=[^&]+/, `s=${'A'.repeat(43)}`);
    assert.equal((await fetch(forged, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
    const page = await fetch(local); // opened in a browser: a button, nothing changed yet
    assert.match(await page.text(), /<form method="post" action="\/alerts\/unsubscribe">/);
    assert.equal((await t.app.alerts.store.settings(5)).email, 'ceo@victim.example');
    const one = await fetch(local, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); // the mail client's button
    assert.equal(one.status, 200);
    const s = await t.app.alerts.store.settings(5);
    assert.deepEqual([s.email, s.channels.email], [null, false]);
    await t.app.alerts.dispatch(8, (await t.db.repos(8))[0], { runId: 'r1', trigger: 'unit-stopped', unit: 'u1' });
    assert.equal(senders.sent.email.at(-1), m, 'no more email');
    assert.equal((await fetch(local, { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status, 400, 'the link is spent once the address is gone');
  } finally { await t.close(); }
});

test('hardening: a push endpoint registered to one person is never moved to another', async () => {
  const t = await startApp({ senders: fakeSenders() });
  try {
    t.gh.addUser('tok-a', { id: 1, login: 'a' }); t.gh.addUser('tok-b', { id: 2, login: 'b' });
    const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/same', keys: { p256dh: 'p', auth: 'x' } });
    const add = async (code) => { const c = await signIn(t, code); return fetch(`${t.base}/alerts/push`, { method: 'POST', body: sub, headers: { Cookie: c, Origin: t.cfg.baseUrl, 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfOf(t, c) } }); };
    assert.equal((await add('a')).status, 204);
    assert.equal((await add('a')).status, 204, 'the owner may post it again');
    assert.equal((await add('b')).status, 409);
    assert.equal((await t.app.alerts.store.pushSubs(1)).length, 1);
    assert.equal((await t.app.alerts.store.pushSubs(2)).length, 0);
  } finally { await t.close(); }
});

test('hardening: a security alert is never posted as a mention on a public repo', async () => {
  const senders = fakeSenders();
  const t = await startApp({ senders });
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { issues: ['acme/web#12'] }) }) });
    await t.db.upsertInstallation({ id: 7, account: 'acme' }); await t.app.ingest.syncInstallation(7);
    const store = t.app.alerts.store;
    await store.subscribe(1, 'ana', 7, 70, Date.now());
    t.gh.addUser('tok-ana', { id: 1, login: 'ana', read: ['acme/web'] });
    const state = (await t.db.run(7, 70, 'r1')).state;
    for (const priv of [false, null, true]) {
      await t.db.upsertRepo({ installationId: 7, id: 70, fullName: 'acme/web', private: priv });
      const out = await t.app.alerts.dispatch(7, (await t.db.repos(7))[0], { runId: 'r1', unit: 'u1', trigger: 'security', key: `secret:${priv}`, once: true, state });
      assert.equal(out[0][2].github, priv === true ? 'sent' : 'public repo', `private: ${priv}`);
    }
    assert.equal(senders.sent.github.length, 1);
  } finally { await t.close(); }
});

test('hardening: comment commands are handled at most COMMANDS_PER_HOUR an hour per installation', async () => {
  const db = guard(memoryDb());
  await db.upsertInstallation({ id: 7, account: 'acme' }); await db.upsertInstallation({ id: 8, account: 'other' });
  const cmds = makeCommands({ db, gh: {}, writes: {}, log: silent });
  const comment = (inst, id) => ({ action: 'created', installation: { id: inst }, repository: { full_name: 'acme/web' }, issue: { number: 1 }, comment: { id, body: '/coordinator note hi', user: { login: 'x', type: 'User' } } });
  const bodies = [];
  for (let i = 1; i <= COMMANDS_PER_HOUR + 5; i++) bodies.push((await cmds.handle(comment(7, i))).body);
  assert.equal(bodies.filter((b) => b === 'command note').length, COMMANDS_PER_HOUR);
  assert.equal(bodies.at(-1), 'ignored: too many commands this hour');
  assert.equal((await cmds.handle(comment(8, 1))).body, 'command note', 'another installation is not affected');
});

// p5 (found clean; kept as a regression test): hostile run text is escaped on every page.
test('p5: hostile goal, notes and lessons are escaped on every page', async () => {
  const t = await startApp();
  try {
    const X = '"><img src=x onerror=alert(1)><script>alert(2)</script>javascript:alert(3)';
    const mapOut = {};
    let log = makeRun('r1', { issues: ['acme/web#12'], mapOut });
    log = appendEvent(log, 'state.edited', { ops: [{ op: 'set', path: ['goal'], value: X }, { op: 'push', path: ['notes'], values: [{ kind: 'person', text: X, at: new Date().toISOString() }] }] });
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: { ...stateFiles({ r1: log }), 'runs/r1/map/events.jsonl': mapOut.map, 'lessons/lessons.json': Buffer.from(JSON.stringify([{ text: X, lesson: X }])) } });
    t.gh.addUser('tok-a', { id: 1, login: 'a', read: ['acme/web'] });
    await t.db.upsertInstallation({ id: 7, account: 'acme' }); await t.app.ingest.syncInstallation(7);
    const cookie = await signIn(t, 'a');
    for (const p of ['/', '/alerts', '/r/acme/web', '/r/acme/web/run/r1', '/r/acme/web/run/r1/unit/u1', '/r/acme/web/run/r1/maps', '/r/acme/web/run/r1/map', '/r/acme/web/coordinator']) {
      const h = await (await fetch(`${t.base}${p}`, { headers: { Cookie: cookie } })).text();
      for (const re of [/<script>alert/i, /<img src=x/i, /href="javascript:/i]) assert.doesNotMatch(h, re, p);
    }
  } finally { await t.close(); }
});
