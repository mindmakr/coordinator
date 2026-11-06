import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { github } from '../src/github.mjs';
import { safeNext, sealer } from '../src/session.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function fakeFetch(routes) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, init });
    const hit = routes.find(([m, re]) => m === init.method && re.test(url));
    const [, , status, body] = hit ?? [null, null, 404, { message: 'Not Found' }];
    return new Response(JSON.stringify(body), { status });
  };
  return { f, seen };
}

const client = (f) => github({ appId: 42, privateKey, clientId: 'cid', clientSecret: 'csec', api: 'https://api.test', web: 'https://gh.test', fetch: f });

test('the App JWT is RS256, signed by the App key, short-lived and issued by the App id', () => {
  const jwt = client(() => {}).appJwt(1_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: 999_940, exp: 1_000_540, iss: '42' });
  assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')), true);
});

test('installation tokens are asked for read-only contents and metadata', async () => {
  const { f, seen } = fakeFetch([['POST', /\/app\/installations\/7\/access_tokens$/, 201, { token: 'inst' }]]);
  assert.equal(await client(f).installationToken(7), 'inst');
  assert.match(seen[0].init.headers.Authorization, /^Bearer ey/);
  assert.deepEqual(JSON.parse(seen[0].init.body), { permissions: { contents: 'read', metadata: 'read' } });
});

test('repoAccess: a 404 is "no access", never an error; a missing branch is null', async () => {
  const { f } = fakeFetch([['GET', /\/repos\/acme\/web$/, 200, { id: 1, permissions: { pull: true } }]]);
  const gh = client(f);
  assert.equal((await gh.repoAccess('t', 'acme/web')).repo.id, 1);
  assert.equal((await gh.repoAccess('t', 'acme/private')).repo, null);
  assert.equal(await gh.ref('t', 'acme/web', 'coordinator-state'), null);
});

test('sign-in exchange posts the code with the client secret to GitHub, not the API', async () => {
  const { f, seen } = fakeFetch([['POST', /^https:\/\/gh\.test\/login\/oauth\/access_token$/, 200, { access_token: 'ghu_x', refresh_token: 'ghr_y', expires_in: 28800 }]]);
  const t = await client(f).exchangeCode('c1', 'https://svc/auth/callback');
  assert.equal(t.token, 'ghu_x'); assert.equal(t.refresh, 'ghr_y'); assert.ok(t.expiresAt > Date.now());
  assert.deepEqual(JSON.parse(seen[0].init.body), { client_id: 'cid', client_secret: 'csec', code: 'c1', redirect_uri: 'https://svc/auth/callback' });
});

test('tokens are sealed with AES-GCM: round trip, and tampering fails', () => {
  const box = sealer('s'.repeat(40));
  const sealed = box.seal('ghu_secret');
  assert.equal(sealed.includes('ghu_secret'), false);
  assert.equal(box.open(sealed), 'ghu_secret');
  const parts = sealed.split('.'); parts[3] = Buffer.from('x').toString('base64url');
  assert.throws(() => box.open(parts.join('.')));
  assert.throws(() => sealer('t'.repeat(40)).open(sealed), 'another key');
});

test('after sign-in only this service\'s own page paths are followed', () => {
  for (const ok of ['/', '/r/acme/web', '/r/acme/web/run/r1/unit/u1']) assert.equal(safeNext(ok), ok);
  for (const bad of ['//evil.example', 'https://evil.example', '/r/acme/web/../../x', '/\\evil', '/login', null, '/r/acme']) assert.equal(safeNext(bad), '/', String(bad));
});
