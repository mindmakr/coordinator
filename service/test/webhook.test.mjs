import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { limiter } from '../src/ratelimit.mjs';
import { verifySignature } from '../src/webhook.mjs';
import { makeRun, startApp, stateFiles } from './helpers.mjs';

const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('verifySignature accepts only the exact HMAC of the raw body', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature('s', body, sign('s', body)), true);
  assert.equal(verifySignature('s', body, sign('other', body)), false, 'wrong secret');
  assert.equal(verifySignature('s', Buffer.from('{"a":2}'), sign('s', body)), false, 'body changed');
  assert.equal(verifySignature('s', body, undefined), false, 'missing');
  assert.equal(verifySignature('s', body, sign('s', body).replace('sha256=', 'sha1=')), false, 'wrong algorithm');
  assert.equal(verifySignature('s', body, 'sha256=abc'), false, 'short');
});

const pushPayload = (over = {}) => ({ ref: 'refs/heads/coordinator-state', after: 'x', installation: { id: 7 }, repository: { id: 70, full_name: 'acme/web', owner: { login: 'acme' } }, ...over });

async function post(t, payload, { delivery = 'd1', event = 'push', secret = t.cfg.github.webhookSecret, sig } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': sig ?? sign(secret, body) } });
}

test('webhook: an unsigned or wrongly signed delivery is refused before parsing', async () => {
  const t = await startApp();
  try {
    let r = await post(t, pushPayload(), { sig: '' });
    assert.equal(r.status, 401);
    r = await post(t, pushPayload(), { secret: 'not-the-secret' });
    assert.equal(r.status, 401);
    r = await fetch(`${t.base}/webhook`, { method: 'POST', body: 'not json', headers: { 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, 'not json') } });
    assert.equal(r.status, 400, 'signed but not JSON');
    assert.equal(t.gh.calls.length, 0, 'GitHub never called');
    assert.equal((await t.db.repos(7)).length, 0, 'nothing stored');
  } finally { await t.close(); }
});

test('webhook: a push to the state branch is ingested once; a redelivery and a same-head push change nothing', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  try {
    let r = await post(t, pushPayload({ ref: 'refs/heads/main' }), { delivery: 'd0' });
    assert.equal(r.status, 202);
    assert.match(await r.text(), /not the state branch/);
    r = await post(t, pushPayload());
    assert.equal(r.status, 202);
    await t.app.idle();
    const runs = await t.db.runs(7, 70);
    assert.deepEqual(runs.map((x) => [x.runId, x.seq, x.error]), [['r1', 7, null]]);
    const calls = t.gh.calls.length;

    r = await post(t, pushPayload()); // the same delivery id: GitHub's redelivery
    assert.equal(r.status, 200);
    assert.match(await r.text(), /duplicate/);
    await t.app.idle();
    assert.equal(t.gh.calls.length, calls, 'a redelivery makes no GitHub call');

    r = await post(t, pushPayload(), { delivery: 'd9' }); // the same signed body under a new delivery id: a replay
    assert.equal(r.status, 200);
    assert.match(await r.text(), /duplicate/);

    r = await post(t, pushPayload({ pusher: { name: 'b' } }), { delivery: 'd2' }); // a new delivery, same branch tip
    await t.app.idle();
    assert.deepEqual(t.gh.calls.slice(calls).map((c) => c[0]), ['installationToken', 'ref'], 'tip unchanged: no tree or blob read');
    assert.deepEqual((await t.db.runs(7, 70)).map((x) => x.seq), [7]);
  } finally { await t.close(); }
});

test('webhook: installation events add and remove repos; a deleted installation leaves no rows', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
  try {
    let r = await post(t, { action: 'created', installation: { id: 7, account: { login: 'acme' } } }, { event: 'installation', delivery: 'i1' });
    assert.equal(r.status, 202);
    await t.app.idle();
    assert.equal((await t.db.runs(7, 70)).length, 1);
    r = await post(t, { action: 'removed', installation: { id: 7 }, repositories_removed: [{ id: 70 }] }, { event: 'installation_repositories', delivery: 'i2' });
    await t.app.idle();
    assert.equal((await t.db.repos(7)).length, 0);
    assert.equal((await t.db.runs(7, 70)).length, 0);
    r = await post(t, { action: 'deleted', installation: { id: 7 } }, { event: 'installation', delivery: 'i3' });
    assert.equal(r.status, 200);
    assert.equal(await t.db.installation(7), null);
  } finally { await t.close(); }
});

// c14: a push sent before an uninstall but delivered after it recreated the installation's rows.
test('webhook: only installation.created makes an installation; a late push, repos or permissions event after an uninstall brings nothing back', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
  try {
    let r = await post(t, pushPayload(), { delivery: 'u0' });
    assert.equal(r.status, 202);
    assert.match(await r.text(), /unknown installation/, 'a push for an installation never created here');
    assert.equal(await post(t, { action: 'created', installation: { id: 7, account: { login: 'acme' } } }, { event: 'installation', delivery: 'u1' }).then((x) => x.status), 202);
    await t.app.idle();
    assert.equal((await t.db.runs(7, 70)).length, 1);
    assert.equal((await post(t, { action: 'deleted', installation: { id: 7 } }, { event: 'installation', delivery: 'u2' })).status, 200);
    const late = [
      ['push', pushPayload({ after: 'late' })],
      ['installation_repositories', { action: 'added', installation: { id: 7, account: { login: 'acme' } }, repositories_added: [{ id: 70, full_name: 'acme/web' }] }],
      ['installation', { action: 'new_permissions_accepted', installation: { id: 7, account: { login: 'acme' } } }],
      ['installation', { action: 'unsuspend', installation: { id: 7, account: { login: 'acme' } } }],
    ];
    for (const [i, [event, body]] of late.entries()) {
      r = await post(t, body, { event, delivery: `late-${i}` });
      assert.equal(r.status, 202, event);
      assert.match(await r.text(), /unknown installation/, event);
    }
    await t.app.idle();
    assert.equal(await t.db.installation(7), null);
    assert.deepEqual(await t.db.repos(7), []);
    assert.deepEqual(await t.db.installationIds(), []);
  } finally { await t.close(); }
});

test('webhook: a delivery without an installation is ignored; ping answers', async () => {
  const t = await startApp();
  try {
    assert.equal((await post(t, { zen: 'hi' }, { event: 'ping' })).status, 200);
    const r = await post(t, { ref: 'refs/heads/coordinator-state', repository: { id: 1, full_name: 'a/b' } }, { delivery: 'n1' });
    assert.equal(r.status, 202);
    assert.match(await r.text(), /no installation/);
  } finally { await t.close(); }
});

test('rate limits: the limiter counts per key and window', () => {
  let now = 0;
  const l = limiter({ max: 2, windowMs: 1000, now: () => now });
  assert.equal(l.hit('a'), 0); assert.equal(l.hit('a'), 0);
  assert.equal(l.hit('a'), 1, 'third in the window is refused');
  assert.equal(l.hit('b'), 0, 'another key is separate');
  now = 1000;
  assert.equal(l.hit('a'), 0, 'a new window');
});

test('rate limits: sign-in is refused with 429 after 30 tries from one address', async () => {
  const t = await startApp();
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await fetch(`${t.base}/login`, { redirect: 'manual' });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  } finally { await t.close(); }
});

test('webhook: a signed push that names no repository is ignored, not an error', async () => {
  const t = await startApp();
  try {
    const r = await post(t, pushPayload({ repository: undefined }), { delivery: 'norepo' });
    assert.equal(r.status, 202);
    assert.match(await r.text(), /no repository/);
    assert.equal((await t.db.repos(7)).length, 0, 'nothing stored');
  } finally { await t.close(); }
});
