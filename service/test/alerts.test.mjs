import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { alertConfig } from '../src/alerts/config.mjs';
import { inQuiet, settingsOf } from '../src/alerts/index.mjs';
import { emailSender, pushSender } from '../src/alerts/senders.mjs';
import { quietSince, runTriggers } from '../src/alerts/triggers.mjs';
import { readLog } from '../src/ingest.mjs';
import { appendEvent, makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

const INST = 7; const REPO = 70;
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function fakeSenders() {
  const sent = { email: [], push: [], github: [] };
  return {
    sent,
    email: { async send(m) { sent.email.push(m); } },
    push: { publicKey: 'BPUBLICKEY', async send(sub, p) { sent.push.push([sub.endpoint, p]); return 'sent'; } },
    github: { async send(i, ref, login, body) { sent.github.push([ref.key, login, body]); } },
  };
}

// An app with acme/web holding run r1 (one open question; u1 links issue #12), and ana subscribed.
async function setup({ runs = { r1: makeRun('r1', { issues: ['acme/web#12'] }) }, settings = { email: 'ana@example.com' }, now, subscribe = true, senders = fakeSenders() } = {}) {
  const t = await startApp({ senders, now });
  t.sent = senders.sent;
  t.gh.addRepo('acme/web', { id: REPO, installationId: INST, files: stateFiles(runs) });
  t.gh.addUser('tok-c1', { id: 5, login: 'ana', read: ['acme/web'] });
  await t.db.upsertInstallation({ id: INST, account: 'acme' });
  await t.db.upsertRepo({ installationId: INST, id: REPO, fullName: 'acme/web', private: true });
  const store = t.app.alerts.store;
  if (subscribe) await store.subscribe(5, 'ana', INST, REPO, Date.now());
  if (settings) await store.putSettings(5, 'ana', settings);
  await store.addPush(5, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } });
  t.sync = async () => { await t.app.ingest.syncInstallation(INST); await t.app.idle(); };
  t.store = store;
  return t;
}

const stateOf = (buf) => readLog('r1', buf).state;

test('triggers: a new question, an answer changed after use, a unit stopped and a finished run', () => {
  const buf = makeRun('r1');
  const before = stateOf(buf);
  const n = Date.now();
  assert.deepEqual(runTriggers(before, before, n), [], 'no change, no alert');
  const first = runTriggers(null, before, n);
  assert.deepEqual(first.map((x) => x.trigger), ['needs-you'], 'first sight: the recent open question');
  assert.deepEqual(runTriggers(null, before, n + 2 * 86_400_000), [], 'first sight of an old question: nothing');
  const after = structuredClone(before);
  after.notes.find((x) => x.kind === 'question').usedAt = new Date().toISOString();
  after.notes.find((x) => x.kind === 'question').history = [{ choices: ['server'], other: null, by: 'person', at: new Date().toISOString() }];
  after.units[0].status = 'stopped';
  after.closed = { outcome: 'stopped', at: new Date().toISOString() };
  const b2 = structuredClone(before);
  b2.notes.find((x) => x.kind === 'question').usedAt = new Date().toISOString();
  assert.deepEqual(runTriggers(b2, after, n).map((x) => x.trigger).sort(), ['answer-changed', 'run-finished', 'unit-stopped']);
  // The lead's pull records a change that reached it after use as a flagged note: alerted once.
  const late = structuredClone(b2);
  late.notes.push({ kind: 'person', text: 'answer changed after use: q1 → client', unit: 'u1', at: new Date().toISOString(), changedAfterUse: { q: 'q1', choices: ['client'], other: null, by: 'person', at: new Date().toISOString() } });
  assert.deepEqual(runTriggers(b2, late, n).map((x) => [x.trigger, x.ref]), [['answer-changed', 'q1']]);
  assert.deepEqual(runTriggers(late, late, n), []);
});

test('triggers: a lead is quiet when units are mid-work and nothing moved for twice the stale budget', () => {
  const s = stateOf(makeRun('r1'));
  const n = Date.now();
  assert.equal(quietSince(s, n + 10 * 3600_000), null, 'no unit is mid-work');
  s.units[0].status = 'building';
  assert.equal(quietSince(s, n), null, 'just now');
  assert.ok(quietSince(s, n + 10 * 3600_000), 'ten hours of silence');
  s.closed = { outcome: 'stopped' };
  assert.equal(quietSince(s, n + 10 * 3600_000), null, 'a closed run is never quiet');
});

test('quiet hours follow the person\'s time zone and span midnight', () => {
  const at = Date.UTC(2026, 10, 7, 23, 30); // 23:30 UTC
  assert.equal(inQuiet(settingsOf({ quiet: { start: 22, end: 7 } }), at), true);
  assert.equal(inQuiet(settingsOf({ quiet: { start: 22, end: 7 }, tz: 'Asia/Riyadh' }), at), true, '02:30 in Riyadh');
  assert.equal(inQuiet(settingsOf({ quiet: { start: 22, end: 7 }, tz: 'America/New_York' }), at), false, '18:30 in New York');
  assert.equal(inQuiet(settingsOf({ quiet: null }), at), false);
});

test('needs-you goes by push, email and a GitHub mention, with minimal content by default', async () => {
  const t = await setup();
  try {
    await t.sync();
    assert.equal(t.sent.push.length, 1);
    const [, p] = t.sent.push[0];
    assert.equal(p.title, 'Coordinator: needs you');
    assert.equal(p.body, 'acme/web · run r1', 'repo and run only');
    assert.equal(p.url, 'http://localhost:3999/r/acme/web/run/r1');
    assert.doesNotMatch(JSON.stringify(t.sent), /Which total/, 'no question text anywhere');
    assert.equal(t.sent.email.length, 1);
    assert.equal(t.sent.email[0].to, 'ana@example.com');
    assert.deepEqual(t.sent.github.map((g) => [g[0], g[1]]), [['acme/web#12', 'ana']], 'mentioned on the unit issue in the state repo');
    const [a] = await t.store.alertsFor(5);
    assert.equal(a.status, 'sent');
    assert.deepEqual(a.detail.channels, { push: 'sent', email: 'sent', github: 'sent' });
    await t.sync();
    assert.equal(t.sent.push.length, 1, 'an unchanged run alerts nobody again');
  } finally { await t.close(); }
});

test('question text only for people who opted in, and only while their access is fresh', async () => {
  const t = await setup({ settings: { email: 'ana@example.com', includeText: true } });
  try {
    await t.sync();
    assert.match(t.sent.push[0][1].body, /Which total\?/);
    assert.match(t.sent.email[0].text, /Which total\?/);
    assert.doesNotMatch(t.sent.github[0][2], /Which total/, 'never in a GitHub comment');
  } finally { await t.close(); }
  const t2 = await setup({ settings: { email: 'ana@example.com', includeText: true } });
  try {
    await t2.store.subscribe(5, 'ana', INST, REPO, Date.now() - 8 * 86_400_000);
    await t2.sync();
    assert.doesNotMatch(t2.sent.push[0][1].body, /Which total/, 'access last confirmed over a week ago: no text');
  } finally { await t2.close(); }
});

test('channels that are off or not configured are skipped and recorded; the rest still go', async () => {
  const t = await setup({ settings: { email: 'ana@example.com', channels: { push: true, email: false, github: false } }, senders: { ...fakeSenders(), email: null, push: null } });
  try {
    await t.sync();
    const [a] = await t.store.alertsFor(5);
    assert.deepEqual(a.detail.channels, { push: 'not configured', email: 'off', github: 'off' });
  } finally { await t.close(); }
  const t2 = await setup({ settings: null, senders: { ...fakeSenders(), email: null, push: null } });
  try {
    await t2.sync(); // GitHub mention with the default fake GitHub-backed sender replaced by the fake
    assert.equal(t2.sent.github.length, 1, 'mention still goes');
    const [a] = await t2.store.alertsFor(5);
    assert.equal(a.detail.channels.email, 'not configured');
  } finally { await t2.close(); }
});

test('a PR merged and checks gone red reach subscribers once; repeats within 15 minutes collapse', async () => {
  const t = await setup({ runs: { r1: makeRun('r1', { prs: ['https://github.com/acme/web/pull/12'] }) } });
  try {
    await t.sync();
    t.sent.push.length = 0;
    const post = async (event, payload, delivery) => {
      const body = JSON.stringify(payload);
      const r = await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, body) } });
      assert.equal(r.status, 202);
      await t.app.idle();
    };
    const suite = (id, conclusion) => ({ action: 'completed', installation: { id: INST }, repository: { id: REPO, full_name: 'acme/web' }, check_suite: { id, conclusion, head_sha: 'abc', updated_at: new Date().toISOString(), pull_requests: [{ number: 12 }] } });
    await post('check_suite', suite(1, 'success'), 'c1');
    assert.equal(t.sent.push.length, 0, 'green checks: no alert');
    await post('check_suite', suite(2, 'failure'), 'c2');
    await post('check_suite', suite(3, 'failure'), 'c3');
    assert.equal(t.sent.push.length, 1, 'red twice: one alert');
    assert.equal(t.sent.push[0][1].title, 'Coordinator: checks failed');
    assert.equal(t.sent.push[0][1].body, 'acme/web · run r1 · unit u1');
    const red = (await t.store.alertsFor(5)).find((a) => a.trigger === 'checks-red');
    assert.equal(red.count, 2, 'the repeat is counted on the first');
    await post('pull_request', { action: 'closed', installation: { id: INST }, repository: { id: REPO, full_name: 'acme/web' }, pull_request: { number: 12, merged: true, merged_at: new Date().toISOString() } }, 'm1');
    assert.equal(t.sent.push.at(-1)[1].title, 'Coordinator: merged');
    assert.equal(t.sent.email.filter((m) => /merged/.test(m.subject)).length, 0, 'merged is push only');
  } finally { await t.close(); }
});

test('quiet hours hold normal alerts for a digest; security alerts ignore them', async () => {
  const h = new Date().getUTCHours();
  const t = await setup({ settings: { email: 'ana@example.com', tz: 'UTC', quiet: { start: h, end: (h + 2) % 24 } } });
  try {
    await t.sync();
    assert.equal(t.sent.push.length + t.sent.email.length + t.sent.github.length, 0, 'held');
    assert.equal((await t.store.alertsFor(5))[0].status, 'queued');
    const body = JSON.stringify({ action: 'created', installation: { id: INST }, repository: { id: REPO, full_name: 'acme/web' }, alert: { number: 4 } });
    const r = await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': 'secret_scanning_alert', 'X-GitHub-Delivery': 's1', 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, body) } });
    assert.equal(r.status, 202);
    await t.app.idle();
    assert.equal(t.sent.push.length, 1, 'high: sent at once');
    assert.equal(t.sent.push[0][1].title, 'Coordinator: security finding');
    assert.equal(t.sent.email.length, 1);
    let sweep = await t.app.alerts.sweep();
    assert.equal(sweep.digests.length, 0, 'still quiet: no digest');
    await t.store.putSettings(5, 'ana', { email: 'ana@example.com', tz: 'UTC', quiet: { start: (h + 3) % 24, end: (h + 4) % 24 } });
    sweep = await t.app.alerts.sweep();
    assert.equal(sweep.digests.length, 1);
    const digest = t.sent.email.at(-1);
    assert.match(digest.subject, /1 alert while you were away/);
    assert.match(digest.text, /needs you: acme\/web · run r1/);
    assert.equal((await t.store.queued(5)).length, 0);
    assert.equal((await t.app.alerts.sweep()).digests.length, 0, 'sent once');
  } finally { await t.close(); }
});

test('a lead gone quiet is alerted once per silence', async () => {
  let buf = makeRun('r1');
  buf = appendEvent(buf, 'unit.start', { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'status'], value: 'building' }] }, 'u1');
  let offset = 0;
  const t = await setup({ runs: { r1: buf }, now: () => Date.now() + offset });
  try {
    await t.sync();
    let s = await t.app.alerts.sweep();
    assert.equal(s.quiet.length, 0, 'not quiet yet');
    offset = 3 * 3600_000;
    s = await t.app.alerts.sweep();
    assert.deepEqual(s.quiet.map((x) => x[1]), ['sent']);
    assert.equal(t.sent.push.at(-1)[1].title, 'Coordinator: lead went quiet');
    s = await t.app.alerts.sweep();
    assert.deepEqual(s.quiet.map((x) => x[1]), ['collapsed'], 'the same silence is not alerted twice');
  } finally { await t.close(); }
});

test('a recipient who lost access hears nothing more, and is unsubscribed; queued alerts for them are dropped', async () => {
  let offset = 0;
  const t = await setup({ settings: { email: 'ana@example.com', includeText: true }, now: () => Date.now() + offset });
  try {
    await t.sync();
    assert.equal(t.sent.push.length, 1, 'access checked as the App, then sent');
    assert.ok(t.gh.calls.some((c) => c[0] === 'userPermission' && c[1] === 'acme/web' && c[2] === 'ana'));
    // Ana loses access; within the 60 s cache nothing new is asked, after it the check says no.
    t.gh.revoke('tok-c1', 'acme/web');
    offset = 61_000;
    const out = await t.app.alerts.dispatch(INST, { id: REPO, fullName: 'acme/web' }, { runId: 'r1', trigger: 'needs-you', question: 'Which total?', key: 'q9' });
    assert.deepEqual(out, [['ana', 'no access']]);
    assert.equal(t.sent.push.length, 1, 'nothing sent, so no question text either');
    assert.deepEqual(await t.store.subscribers(INST, REPO), [], 'unsubscribed');
  } finally { await t.close(); }

  const h = new Date().getUTCHours();
  let later = 0;
  const t2 = await setup({ settings: { email: 'ana@example.com', tz: 'UTC', quiet: { start: h, end: (h + 2) % 24 } }, now: () => Date.now() + later });
  try {
    await t2.sync();
    assert.equal((await t2.store.queued(5)).length, 1);
    t2.gh.revoke('tok-c1', 'acme/web');
    await t2.store.putSettings(5, 'ana', { email: 'ana@example.com', tz: 'UTC', quiet: { start: (h + 3) % 24, end: (h + 4) % 24 } });
    later = 61_000; // past the cached answer: the digest asks again
    const sweep = await t2.app.alerts.sweep();
    assert.equal(sweep.digests.length, 0, 'no digest to someone who lost access');
    assert.equal((await t2.store.queued(5)).length, 0, 'and the queue is cleared');
    assert.equal(t2.sent.email.length, 0);
  } finally { await t2.close(); }
});

test('nobody hears about a repo they did not subscribe to', async () => {
  const t = await setup({ subscribe: false });
  try {
    await t.sync();
    assert.equal(t.sent.push.length + t.sent.email.length + t.sent.github.length, 0);
  } finally { await t.close(); }
});

// The alerts pages, through the real routes.
async function page(t, cookie) {
  const r = await fetch(`${t.base}/alerts`, { headers: { Cookie: cookie } });
  const html = await r.text();
  return { r, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] };
}
const form = (t, cookie, path, fields) => fetch(`${t.base}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: t.cfg.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('alerts page: subscribe needs read access; settings save; an email is used only once confirmed', async () => {
  const t = await setup({ subscribe: false, settings: null });
  t.gh.addRepo('acme/secret', { id: 71, installationId: INST, files: null });
  try {
    assert.equal((await fetch(`${t.base}/alerts`, { redirect: 'manual' })).status, 302, 'signed out: to sign-in');
    const cookie = await signIn(t, 'c1');
    let p = await page(t, cookie);
    assert.equal(p.r.status, 200);
    assert.match(p.r.headers.get('content-security-policy'), /script-src 'self'.*frame-ancestors 'none'/);
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(p.html)?.[1] ?? '';
    assert.match(meta, /script-src 'self'/); assert.doesNotMatch(meta, /frame-ancestors/, 'ignored in a meta tag: header only');
    assert.doesNotMatch(p.html, /Snapshot · read-only|class="themes"/, 'no run chip and no theme buttons on a settings page');
    assert.match(p.html, /email is not set up|Web push/);
    let r = await form(t, cookie, '/alerts/watch', { csrf: p.csrf, repo: 'acme/secret', on: '1' });
    assert.equal(r.status, 404, 'a repo ana cannot read');
    r = await form(t, cookie, '/alerts/watch', { csrf: 'wrong', repo: 'acme/web', on: '1' });
    assert.equal(r.status, 403, 'CSRF');
    r = await form(t, cookie, '/alerts/watch', { csrf: p.csrf, repo: 'acme/web', on: '1' });
    assert.equal(r.status, 303);
    assert.equal((await t.store.subscribers(INST, REPO)).length, 1);
    r = await form(t, cookie, '/alerts/settings', { csrf: p.csrf, email: 'ana@example.com', tz: 'Europe/London', quiet_start: '22', quiet_end: '7', ch_push: '1', ch_email: '1' });
    assert.match(await r.text(), /We sent a link to ana@example.com/);
    let s = await t.store.settings(5);
    assert.equal(s.email ?? null, null, 'not used until confirmed');
    assert.deepEqual([s.tz, s.quiet, s.channels.github], ['Europe/London', { start: 22, end: 7 }, false]);
    const link = /confirm\?t=([A-Za-z0-9_-]+)/.exec(t.sent.email[0].text)[1];
    assert.equal((await fetch(`${t.base}/alerts/confirm?t=x${link.slice(1)}`)).status, 400, 'a wrong token');
    const opened = await fetch(`${t.base}/alerts/confirm?t=${link}`); // what a mail scanner does
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /<form method="post" action="\/alerts\/confirm">.*Confirm this address/s);
    assert.equal((await t.store.settings(5)).email ?? null, null, 'opening the link confirms nothing');
    const confirm = () => fetch(`${t.base}/alerts/confirm`, { method: 'POST', body: new URLSearchParams({ t: link }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const done = await confirm();
    assert.equal(done.status, 200);
    assert.match(await done.text(), /Email confirmed/);
    s = await t.store.settings(5);
    assert.equal(s.email, 'ana@example.com');
    assert.equal((await confirm()).status, 400, 'used once');
    assert.equal((await fetch(`${t.base}/alerts/confirm?t=${link}`)).status, 400, 'and the page says so');
    r = await form(t, cookie, '/alerts/settings', { csrf: p.csrf, tz: 'Mars/Olympus' });
    assert.match(await r.text(), /Unknown time zone/);
    p = await page(t, cookie);
    assert.match(p.html, /Stop alerts/);
  } finally { await t.close(); }
});

test('alerts page: a push subscription needs the CSRF header and a known push service', async () => {
  const t = await setup({ subscribe: false, settings: null });
  try {
    const cookie = await signIn(t, 'c1');
    const { html, csrf } = await page(t, cookie);
    assert.match(html, /id="push-on" data-key="BPUBLICKEY"/);
    const post = (sub, token = csrf) => fetch(`${t.base}/alerts/push`, { method: 'POST', headers: { Cookie: cookie, Origin: t.cfg.baseUrl, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(sub) });
    const keys = { p256dh: 'BKEY', auth: 'AUTH' };
    assert.equal((await post({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys }, 'nope')).status, 403);
    assert.equal((await post({ endpoint: 'https://169.254.169.254/latest', keys })).status, 400, 'not a push service');
    assert.equal((await post({ endpoint: 'http://fcm.googleapis.com/x', keys })).status, 400, 'not https');
    assert.equal((await post({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys })).status, 204);
    assert.equal((await t.store.pushSubs(5)).length, 2);
    for (const f of ['/alerts/sw.js', '/alerts/push.js']) {
      const r = await fetch(`${t.base}${f}`);
      assert.match(r.headers.get('content-type'), /javascript/);
    }
  } finally { await t.close(); }
});

// A fake SMTP server: enough of RFC 5321 for nodemailer, keeping each message.
function fakeSmtp() {
  const got = [];
  const server = createServer((sock) => {
    let data = false; let buf = ''; let msg = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; got.push(msg); msg = ''; sock.write('250 queued\r\n'); } else msg += `${line}\n`; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 fake\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n');
      }
    });
  });
  return { got, server };
}

test('email: the SMTP sender delivers through the configured server; unset SMTP means no sender', async () => {
  assert.equal(emailSender(alertConfig({}).smtp), null);
  const { got, server } = fakeSmtp();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const cfg = alertConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_FROM: 'Coordinator <c@example.com>' });
    const mail = emailSender({ ...cfg.smtp, ignoreTLS: true });
    await mail.send({ to: 'ana@example.com', subject: 'Coordinator: needs you', text: 'acme/web · run r1' });
    mail.close();
    assert.equal(got.length, 1);
    assert.match(got[0], /Subject: Coordinator: needs you/);
    assert.match(got[0], /To: ana@example.com/);
  } finally { server.close(); }
});

test('push: no VAPID keys, no sender; half a key pair is refused at start', () => {
  assert.equal(pushSender(alertConfig({}).vapid), null);
  assert.throws(() => alertConfig({ VAPID_PUBLIC_KEY: 'x' }), /both/);
  assert.throws(() => alertConfig({ VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y', VAPID_SUBJECT: 'http://x' }), /mailto/);
  assert.throws(() => alertConfig({ ALERT_SWEEP_SECONDS: '1' }), /range/);
  const p = pushSender({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', privateKey: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls', subject: 'mailto:a@example.com' });
  assert.equal(typeof p.send, 'function');
});

test('with no senders configured, the GitHub mention still goes, as the App, with no question text', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: REPO, installationId: INST, files: stateFiles({ r1: makeRun('r1', { issues: ['acme/web#12'] }) }) });
  t.gh.addUser('tok-ana', { id: 5, login: 'ana', read: ['acme/web'] });
  try {
    await t.db.upsertInstallation({ id: INST, account: 'acme' });
    await t.db.upsertRepo({ installationId: INST, id: REPO, fullName: 'acme/web', private: true });
    await t.app.alerts.store.subscribe(5, 'ana', INST, REPO, Date.now());
    await t.app.alerts.store.putSettings(5, 'ana', { email: 'ana@example.com', includeText: true });
    await t.app.ingest.syncInstallation(INST);
    await t.app.idle();
    const mention = (t.gh.comments.get('acme/web#12') ?? []).find((c) => c.body.startsWith('@ana '));
    assert.ok(mention, 'mentioned');
    assert.match(mention.body, /needs you/);
    assert.doesNotMatch(mention.body, /Which total/);
    const [a] = await t.app.alerts.store.alertsFor(5);
    assert.deepEqual(a.detail.channels, { push: 'not configured', email: 'not configured', github: 'sent' });
    // A second alert for ana on the same issue replaces her first: the issue keeps one alert comment for her.
    await t.app.alerts.dispatch(INST, { id: REPO, fullName: 'acme/web' }, { runId: 'r1', unit: 'u1', trigger: 'needs-you', key: 'q2', state: (await t.db.run(INST, REPO, 'r1')).state });
    const mine = (t.gh.comments.get('acme/web#12') ?? []).filter((c) => c.body.startsWith('@ana '));
    assert.equal(mine.length, 1);
    assert.notEqual(mine[0].id, mention.id);
    assert.ok(t.gh.calls.some((c) => c[0] === 'deleteComment' && c[2] === mention.id));
  } finally { await t.close(); }
});
