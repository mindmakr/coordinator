// c14 round 3: the webhook budget per client address, the body deadline, alert addresses folded
// the way the SMTP envelope folds them, and a removed repo's alerts.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { test } from 'node:test';
import { normalEmail } from '../src/alerts/routes.mjs';
import { MAX_WEBHOOK_INFLIGHT, MAX_WEBHOOK_PER_IP, WEBHOOK_RESERVE } from '../src/server.mjs';
import { makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
// Waits for a condition, not for a time: the bytes a stalled body sent are counted once the server has read them.
const until = async (ok) => { while (!ok()) await new Promise((r) => setTimeout(r, 5)); };
let n = 0;

// Sends the headers and `send` bytes of a body declared `length` long, from address `ip` (TRUST_PROXY), and
// leaves it open. → { status: Promise of the answer's status, or 'closed' }
function stall(t, ip, length, send) {
  const port = Number(new URL(t.base).port);
  const s = connect(port, '127.0.0.1');
  const status = new Promise((ok) => {
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('close', () => ok(Number(/^HTTP\/1\.1 (\d+)/.exec(got)?.[1]) || 'closed'));
    s.on('error', () => {});
  });
  s.write(`POST /webhook HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${ip}\r\nContent-Length: ${length}\r\nX-Hub-Signature-256: sha256=00\r\n\r\n`);
  if (send) s.write(Buffer.alloc(send, 0x61));
  return { status, socket: s };
}
const signed = async (t, ip, pad = '') => {
  const b = JSON.stringify({ zen: 'hi', hook_id: 1, installation: { id: 7 }, pad });
  const r = await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-Forwarded-For': ip, 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': `e-${++n}`, 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, b) } });
  return r.status;
};

test('c14: stalled bodies cannot starve the webhook: a cap per address group, a reserve for GitHub, and a deadline', async () => {
  // The deadline is long enough that no stalled body is cut before every one is counted, even on a busy machine.
  const t = await startApp({ over: { trustProxy: true, webhookBodyMs: 5000 } });
  const open = [];
  try {
    const M = MAX_WEBHOOK_PER_IP;
    // One address group (IPv4 /24): its first body is read, a second waits its turn (429) before a byte is read.
    open.push(stall(t, '10.0.0.1', M, M - 1));
    await until(() => t.app.webhookBytes().used >= M - 1);
    const second = stall(t, '10.0.0.2', M, 10); open.push(second);
    assert.equal(await second.status, 429);
    // Many groups: bodies fill the budget up to the reserve, and no further.
    const groups = Math.floor((MAX_WEBHOOK_INFLIGHT - WEBHOOK_RESERVE) / M);
    assert.ok(groups >= 50, `filling the budget takes ${groups} groups`);
    for (let i = 2; i <= groups; i++) open.push(stall(t, `10.${i}.0.1`, M, M - 1));
    await until(() => t.app.webhookBytes().used >= groups * (M - 1));
    const over = stall(t, '10.200.0.1', M, 10); open.push(over);
    assert.equal(await over.status, 503, 'the reserve is not for them');
    const b = t.app.webhookBytes();
    assert.ok(b.used >= groups * (M - 1) && b.used <= MAX_WEBHOOK_INFLIGHT - WEBHOOK_RESERVE, `${b.used}`);
    // GitHub's deliveries still get through, from its hook addresses; nobody else reaches the reserve.
    assert.equal(await signed(t, '140.82.115.1', 'x'.repeat(6000)), 200);
    assert.equal(await signed(t, '192.0.2.10', 'x'.repeat(6000)), 503);
    // The deadline: every stalled body is cut, its bytes are released, and it counts as a refusal.
    const codes = await Promise.all(open.slice(0, 1).concat(open.slice(2, -1)).map((x) => x.status));
    assert.ok(codes.every((c) => c === 408 || c === 'closed'), String(codes));
    assert.equal(t.app.webhookBytes().used, 0, 'every byte is released');
    assert.equal(await signed(t, '192.0.2.10'), 200, 'and the budget is whole again');
  } finally { for (const x of open) x.socket.destroy(); await t.close(); }
});

test('c14: a body that stalls counts as a refused delivery for its address', async () => {
  const t = await startApp({ over: { trustProxy: true, webhookBodyMs: 300 } });
  const open = [];
  try {
    for (let i = 0; i < 30; i++) open.push(stall(t, '10.9.9.9', 100, 10)); // small, so all are read at once
    await Promise.all(open.map((x) => x.status));
    const late = stall(t, '10.9.9.9', 100, 100); open.push(late);
    assert.equal(await late.status, 429, 'past the failure limit: answered before the body is read');
    assert.equal(await signed(t, '10.1.1.1'), 200, 'another address is not affected');
  } finally { for (const x of open) x.socket.destroy(); await t.close(); }
});

test('c14: alert addresses are folded the way the SMTP envelope sees them (NFKC, then IDNA)', async () => {
  const fw = (s) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
  assert.deepEqual(normalEmail(`victim@${fw('example')}.org`), { address: 'victim@example.org', key: 'victim@example.org' });
  assert.deepEqual(normalEmail(`${fw('Victim')}@EXAMPLE.org`), { address: 'Victim@example.org', key: 'victim@example.org' });
  assert.equal(normalEmail('a@exa​mple.org').address, 'a@example.org', 'zero-width characters are mapped away');
  assert.equal(normalEmail('a@bücher.de').address, 'a@xn--bcher-kva.de');
  assert.equal(normalEmail('a@xn--bcher-kva.de').address, 'a@xn--bcher-kva.de');
  for (const bad of ['', 'nope', '@example.org', 'vïctim@example.org', 'a\u0001b@example.org', 'a@b', 'a@exa mple.org']) assert.equal(normalEmail(bad), null, JSON.stringify(bad));

  // Through the page: three accounts, five spellings of one mailbox; it gets the per-address cap and no more.
  const sent = [];
  const t = await startApp({ senders: { email: { async send(m) { sent.push(m.to); } }, push: null, github: { async send() {} } } });
  try {
    const spellings = ['victim@example.org', `victim@${fw('example')}.org`, `victim@${fw('exa')}mple.org`, `VICTIM@e${fw('xample')}.org`, `victim@ex${fw('ample')}.ORG`];
    for (let k = 0; k < 3; k++) {
      t.gh.addUser(`tok-m${k}`, { id: 50 + k, login: `m${k}`, read: [] });
      const cookie = await signIn(t, `m${k}`);
      const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${t.base}/alerts`, { headers: { Cookie: cookie } })).text())[1];
      for (let i = 0; i < 3; i++) await fetch(`${t.base}/alerts/settings`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, email: spellings[(k * 3 + i) % spellings.length], tz: 'UTC' }), headers: { Cookie: cookie, Origin: t.cfg.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' } });
    }
    assert.equal(sent.length, 3);
    assert.ok(sent.every((to) => /^victim@example\.org$/i.test(to)), String(sent));
    const stored = await t.app.alerts.store.settings(50);
    assert.equal(stored.emailPending, 'victim@example.org', 'the folded address is the one kept and mailed');
  } finally { await t.close(); }
});

test('c14: a repo removed from an installation takes its alerts with it, sent and queued for a digest', async () => {
  const d = new Date(); const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12); // recent: Postgres prunes alerts after 90 days
  const t = await startApp({ now: () => noon });
  try {
    t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
    t.gh.addRepo('acme/api', { id: 71, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
    t.gh.addUser('tok-ana', { id: 1, login: 'ana', read: ['acme/web', 'acme/api'] });
    await t.db.upsertInstallation({ id: 7, account: 'acme' }); await t.app.ingest.syncInstallation(7);
    const store = t.app.alerts.store;
    await store.putSettings(1, 'ana', { email: 'ana@example.com', quiet: { start: 6, end: 18 }, tz: 'UTC' });
    const repos = await t.db.repos(7);
    for (const r of repos) {
      await store.subscribe(1, 'ana', 7, r.id, noon);
      await t.app.alerts.dispatch(7, r, { runId: 'r1', trigger: 'run-finished' }); // quiet hours: queued for the digest
      await t.app.alerts.dispatch(7, r, { runId: 'r1', trigger: 'security', key: 'secret:1', once: true }); // sent
    }
    const of = async (repoId) => (await store.alertsFor(1)).filter((a) => a.repoId === repoId).map((a) => a.status).sort();
    assert.deepEqual(await of(70), ['queued', 'sent']);

    const b = JSON.stringify({ action: 'removed', installation: { id: 7 }, repositories_removed: [{ id: 70 }], repositories_added: [] });
    const r = await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-GitHub-Event': 'installation_repositories', 'X-GitHub-Delivery': 'rm-1', 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, b) } });
    assert.equal(r.status, 202);
    await t.app.idle();
    assert.deepEqual(await of(70), [], 'the removed repo: no alerts, no digest entries');
    assert.deepEqual(await of(71), ['queued', 'sent'], 'the other repo is untouched');
    assert.deepEqual((await store.subscriptions(1)).map((s) => s.repoId), [71]);
    assert.deepEqual((await store.queued(1)).map((a) => a.repoId), [71], 'the next digest carries nothing from it');
  } finally { await t.close(); }
});
