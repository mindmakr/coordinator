import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

test('sign-in uses PKCE: the challenge is the S256 of the verifier sent only with the exchange', async () => {
  const t = await startApp();
  t.gh.addUser('tok-x', { id: 9, login: 'x' });
  try {
    const start = await fetch(`${t.base}/login`, { redirect: 'manual' });
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    const challenge = loc.searchParams.get('code_challenge');
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const back = await fetch(`${t.base}/auth/callback?code=x&state=${loc.searchParams.get('state')}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(back.status, 302);
    const verifier = t.gh.calls.find((c) => c[0] === 'exchangeCode')[2];
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
    assert.equal(loc.toString().includes(verifier), false, 'the verifier never goes to the browser URL');
  } finally { await t.close(); }
});

test('signing in again replaces the session: the old cookie stops working', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
  t.gh.addUser('tok-r', { id: 1, login: 'r', read: ['acme/web'] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  try {
    const first = await signIn(t, 'r');
    const start = await fetch(`${t.base}/login`, { headers: { Cookie: first }, redirect: 'manual' });
    const oauth = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const back = await fetch(`${t.base}/auth/callback?code=r&state=${state}`, { headers: { Cookie: `${oauth}; ${first}` }, redirect: 'manual' });
    const second = back.headers.getSetCookie().find((c) => c.startsWith('coordinator=')).split(';')[0];
    assert.notEqual(second, first);
    assert.equal((await fetch(`${t.base}/r/acme/web`, { headers: { Cookie: first }, redirect: 'manual' })).status, 302, 'old session gone');
    assert.equal((await fetch(`${t.base}/r/acme/web`, { headers: { Cookie: second }, redirect: 'manual' })).status, 200);
  } finally { await t.close(); }
});

test('signed webhook deliveries are never rate limited; refused ones are', async () => {
  const t = await startApp();
  const post = (body, sig) => fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig } });
  const sign = (b) => `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(b).digest('hex')}`;
  try {
    for (let i = 0; i < 350; i++) {
      const b = JSON.stringify({ zen: i });
      const r = await post(b, sign(b));
      assert.equal(r.status, 200, `signed delivery ${i}`);
    }
    let last;
    for (let i = 0; i < 31; i++) last = await post('{}', 'sha256=00');
    assert.equal(last.status, 429, 'refused deliveries are limited');
  } finally { await t.close(); }
});

test('an unknown repo is checked with GitHub like a known one the viewer cannot read', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/secret', { id: 71, installationId: 7, files: stateFiles({ s1: makeRun('s1') }) });
  t.gh.addUser('tok-o', { id: 3, login: 'o', read: [] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  try {
    const cookie = await signIn(t, 'o');
    const asked = (name) => t.gh.calls.filter((c) => c[0] === 'repoAccess' && c[2] === name).length;
    const a = await fetch(`${t.base}/r/acme/secret`, { headers: { Cookie: cookie } });
    const b = await fetch(`${t.base}/r/acme/nothing`, { headers: { Cookie: cookie } });
    assert.equal(a.status, 404); assert.equal(b.status, 404);
    assert.equal(await a.text(), await b.text());
    assert.equal(asked('acme/secret'), 1); assert.equal(asked('acme/nothing'), 1, 'the same GitHub call for an unknown repo');
  } finally { await t.close(); }
});

test('ACCESS_TTL_SECONDS is capped at 60', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const env = { BASE_URL: 'http://localhost:3000', SESSION_SECRET: 's'.repeat(40), GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_CLIENT_ID: 'c', GITHUB_CLIENT_SECRET: 's', GITHUB_WEBHOOK_SECRET: 'w' };
  assert.equal(loadConfig({ ...env, ACCESS_TTL_SECONDS: '60' }).accessTtlMs, 60_000);
  assert.throws(() => loadConfig({ ...env, ACCESS_TTL_SECONDS: '61' }), /range/);
});
