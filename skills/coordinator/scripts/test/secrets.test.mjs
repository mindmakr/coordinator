import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSecret, maskSecrets } from '../lib/secrets.mjs';

test('common credential shapes are found and masked', () => {
  for (const s of [
    'DB_PASSWORD=SuperSecret99', 'GITHUB_TOKEN=0123456789abcdef0123456789abcdef01234567', 'api_key=abc123def456',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Bearer abcdefghijklmnop1234', 'glpat-abcdefghijklmnop1234',
    'postgres://user:pass@host/db', 'the password is hunter22x', 'sk_live_abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'pass=Sup3rS3cret!', 'Authorization: Token 9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
    'SECRET_KEY=a8f3k2l9x0q1w7e', 'JWT_SECRET_KEY=a8f3k2l9x0q1w7e', 'STRIPE_KEY=whsec_a8f3k2l9x0q1', '"password": "p@ss w0rd"',
  ]) {
    assert.equal(findSecret(s), true, s);
    assert.match(maskSecrets(`x ${s} y`), /\[redacted\]/, s);
  }
});

test('paths, file:line evidence and plain prose are left alone', () => {
  for (const s of [
    'frontend/src/app/DashboardLayout/MainPanel2View.tsx:42 fails', 'the token is expired after refresh',
    'Tests 5802 passed | 1 skipped', 'backend/src/services/shared/employer-standing-timeline.ts:157', 'set --max-rounds to 4',
    'token: undefined in refresh handler', 'api_key: missing from config.yaml', 'secret: rotate script never runs', 'auth=broken',
    'Bearer authentication middleware', 'the token is 401-ing', 'auth: middleware rejects the call', 'Refresh fails when token: expired',
    'auth: src/auth/login.ts:42 throws on refresh', 'token: src/lib/token.ts:88', 'secret: ../config/secret.yaml is missing',
  ]) {
    assert.equal(findSecret(s), false, s);
    assert.equal(maskSecrets(s), s);
  }
});

// A regex with ambiguous repeats took 173 s on 'token_' x 2000 and froze the hosted service.
test('masking is linear: adversarial inputs finish in under 50 ms', () => {
  const N = 5000;
  const inputs = [
    'token_'.repeat(N), 'token='.repeat(N), 'token=x,'.repeat(N), 'token=/:1'.repeat(N), 'token: '.repeat(N), 'token is '.repeat(N),
    'token="'.repeat(N), 'a-'.repeat(3 * N), 'a_'.repeat(3 * N), 'eyJ-'.repeat(N), `${'eyJ-'.repeat(60)}.${'a'.repeat(30000)}`,
    'a://'.repeat(N), 'a.'.repeat(3 * N), `x://${'a:'.repeat(3 * N)}`, 'glpat-'.repeat(N), 'xoxb-'.repeat(N), 'sk-'.repeat(N), 'ghp_'.repeat(N),
    'bearer '.repeat(N), 'authorization:'.repeat(N), '-----BEGIN '.repeat(N), `-----BEGIN RSA PRIVATE KEY-----${'-----END '.repeat(N)}`,
    `token${' '.repeat(30000)}`, `${'aB3'.repeat(2 * N)}/`, 'DB_PASSWORD_token-api_key='.repeat(1500),
  ];
  for (const s of inputs) {
    maskSecrets(s.slice(0, 64)); // warm up
    const a = performance.now();
    maskSecrets(s); findSecret(s);
    const ms = performance.now() - a;
    assert.ok(ms < 50, `${JSON.stringify(s.slice(0, 24))}… (${s.length} chars) took ${ms.toFixed(0)} ms`);
  }
});

test('long text is masked window by window and still catches secrets anywhere in it', () => {
  const filler = 'lorem ipsum dolor sit amet\n'.repeat(1000); // 27 KB, several windows
  const text = `${filler}DB_PASSWORD=SuperSecret99 ${filler}ghp_abcdefghijklmnopqrstuvwxyz0123 ${filler}`;
  const out = maskSecrets(text);
  assert.equal(out.match(/\[redacted\]/g)?.length, 2);
  assert.equal(out.length, text.length - 'DB_PASSWORD=SuperSecret99'.length - 'ghp_abcdefghijklmnopqrstuvwxyz0123'.length + 2 * '[redacted]'.length);
  assert.equal(findSecret(text), true);
  assert.equal(findSecret(filler), false);
  const pem = `${filler}-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA\n'.repeat(600)}-----END RSA PRIVATE KEY-----\nafter`;
  assert.equal(maskSecrets(pem), `${filler}[redacted]\nafter`, 'a key longer than a window is masked whole');
});

test('named values: the same names and values as before the tokenizer', () => {
  const cases = [
    ['x "password": "p@ss w0rd" y', 'x [redacted] y'], ['a__token=abc12345', 'a__[redacted]'], ['mytoken=abc12345', 'mytoken=abc12345'],
    ['MY_API-KEY = "abcdef"', '[redacted]'], ['token=abc12345token=xyz', '[redacted]'], ['the Token IS hunter22x ok', 'the [redacted] ok'],
    ['client_secret: src/a.ts:4', 'client_secret: src/a.ts:4'], ['x"secret"=abc12345', 'x"[redacted]'], ['api_key: "short"', 'api_key: "short"'],
  ];
  for (const [s, want] of cases) assert.equal(maskSecrets(s), want, s);
});
