import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WINDOW, findSecret, maskSecrets } from '../lib/secrets.mjs';

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
// Wall-clock limits flake under load, so this checks growth instead: 4x the text may take
// about 4x the time (the bound allows 8x plus 25 ms of noise); quadratic work would take 16x.
test('masking is linear: adversarial inputs scale with their length', () => {
  const inputs = [
    (n) => 'token_'.repeat(n), (n) => 'token='.repeat(n), (n) => 'token=x,'.repeat(n), (n) => 'token=/:1'.repeat(n), (n) => 'token: '.repeat(n),
    (n) => 'token is '.repeat(n), (n) => 'token="'.repeat(n), (n) => 'a-'.repeat(3 * n), (n) => 'a_'.repeat(3 * n), (n) => 'eyJ-'.repeat(n),
    (n) => `${'eyJ-'.repeat(60)}.${'a'.repeat(6 * n)}`, (n) => 'a://'.repeat(n), (n) => 'a.'.repeat(3 * n), (n) => `x://${'a:'.repeat(3 * n)}`,
    (n) => 'glpat-'.repeat(n), (n) => 'xoxb-'.repeat(n), (n) => 'sk-'.repeat(n), (n) => 'ghp_'.repeat(n), (n) => 'bearer '.repeat(n),
    (n) => 'authorization:'.repeat(n), (n) => '-----BEGIN '.repeat(n), (n) => `-----BEGIN RSA PRIVATE KEY-----${'-----END '.repeat(n)}`,
    (n) => `token${' '.repeat(6 * n)}`, (n) => `${'aB3'.repeat(2 * n)}/`, (n) => 'DB_PASSWORD_token-api_key='.repeat(n / 4),
  ];
  const time = (s) => {
    let best = Infinity;
    for (let r = 0; r < 3; r++) { const a = performance.now(); maskSecrets(s); findSecret(s); best = Math.min(best, performance.now() - a); }
    return best;
  };
  const N = 2500;
  for (const make of inputs) {
    const small = make(N); const large = make(4 * N);
    maskSecrets(small.slice(0, 64)); // warm up
    const t1 = time(small); const t4 = time(large);
    const label = `${JSON.stringify(small.slice(0, 24))}…: ${small.length} chars ${t1.toFixed(1)} ms, ${large.length} chars ${t4.toFixed(1)} ms`;
    assert.ok(t4 < 8 * t1 + 25, `grows faster than its length: ${label}`);
    assert.ok(t4 < 5000, `too slow: ${label}`);
  }
});

// Each kind of secret, placed so it starts or ends at every offset around a window's edge,
// in a line with no whitespace (minified JSON): masked exactly as it is on its own.
test('a secret across a window edge is masked and found', () => {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE', 'DB_PASSWORD=Sup3rS3cret!x', 'xoxb-1234567890-abcdefghij', 'ghp_A1b2C3d4E5f6G7h8I9j0',
    'postgres://admin:Pa55word@db.internal', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
    'sk_live_abcdefghijklmnop1234', 'aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX', `ghp_${'A1b2C3d4'.repeat(400)}`,
  ];
  for (const edge of [WINDOW, 2 * WINDOW]) {
    for (const sec of secrets) {
      const want = maskSecrets(sec);
      assert.notEqual(want, sec, sec);
      for (let start = edge - Math.min(sec.length, 64) - 3; start <= edge + 3; start++) {
        const pre = `{"log":"${'x'.repeat(start - 9)},`;
        const post = `,${'y'.repeat(3 * WINDOW)}"}`;
        const s = pre + sec + post;
        assert.equal(maskSecrets(s), pre + want + post, `${sec.slice(0, 12)} at ${start}`);
        assert.equal(findSecret(s), true, `${sec.slice(0, 12)} at ${start}`);
      }
    }
  }
  // Read with the characters before it: "mytoken=" cut after "my" is still not a credential name.
  for (let start = WINDOW - 10; start <= WINDOW + 2; start++) {
    const s = `${'x'.repeat(start - 1)},mytoken=abc12345,${'y'.repeat(WINDOW)}`;
    assert.equal(maskSecrets(s), s, `mytoken at ${start}`);
    assert.equal(findSecret(s), false, `mytoken at ${start}`);
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
