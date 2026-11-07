import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WINDOW, findSecret, maskSecrets, readCost } from '../lib/secrets.mjs';

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
// Wall-clock comparisons flake under load, so this counts the characters the masker reads
// (readCost) at two sizes, 8x apart.
test('masking is linear: adversarial inputs scale with their length', () => {
  const inputs = [
    (n) => 'token_'.repeat(n), (n) => 'token='.repeat(n), (n) => 'token=x,'.repeat(n), (n) => 'token=/:1'.repeat(n), (n) => 'token: '.repeat(n),
    (n) => 'token is '.repeat(n), (n) => 'token="'.repeat(n), (n) => 'a-'.repeat(3 * n), (n) => 'a_'.repeat(3 * n), (n) => 'eyJ-'.repeat(n),
    (n) => `${'eyJ-'.repeat(60)}.${'a'.repeat(6 * n)}`, (n) => 'a://'.repeat(n), (n) => 'a.'.repeat(3 * n), (n) => `x://${'a:'.repeat(3 * n)}`,
    (n) => 'glpat-'.repeat(n), (n) => 'xoxb-'.repeat(n), (n) => 'sk-'.repeat(n), (n) => 'ghp_'.repeat(n), (n) => 'bearer '.repeat(n),
    (n) => 'authorization:'.repeat(n), (n) => '-----BEGIN '.repeat(n), (n) => `-----BEGIN RSA PRIVATE KEY-----${'-----END '.repeat(n)}`,
    (n) => `token${' '.repeat(6 * n)}`, (n) => `${'aB3'.repeat(2 * n)}/`, (n) => 'DB_PASSWORD_token-api_key='.repeat(n / 4),
    (n) => `password="${'a'.repeat(6 * n)}`, (n) => 'password="a '.repeat(n), (n) => `${'a'.repeat(6 * n)} `, (n) => `key="${'a '.repeat(3 * n)}`,
    (n) => `${'x'.repeat(5000)} `.repeat(n / 800), (n) => `${'x'.repeat(30000)} `.repeat(n / 4000), (n) => `"${'y'.repeat(20000)}`.repeat(n / 3000),
  ];
  const N = 1250;
  for (const make of inputs) {
    const large = make(4 * N); const huge = make(32 * N);
    const c4 = readCost(large); const c32 = readCost(huge);
    const label = `${JSON.stringify(large.slice(0, 24))}…: ${large.length} chars ${c4}, ${huge.length} chars ${c32}`;
    // At most 5 reads per character plus one window's worth: quadratic work would read ~8x more per character.
    assert.ok(c4 <= 5 * large.length + 4 * WINDOW && c32 <= 5 * huge.length + 4 * WINDOW, `reads too much: ${label}`);
  }
});

// Each kind of secret, quoted and not, short and 1-8 KB long, placed so it starts or ends at each
// offset around a window's cut and the edges of what that window reads (2048 either side), in
// minified JSON (no whitespace) and in prose: masked exactly as it is on its own, and found.
test('a secret across a window edge is masked and found', () => {
  const b64 = (len, url) => {
    let s = '';
    for (let i = 0; s.length < len; i++) s += createHash('sha512').update(String(i)).digest(url ? 'base64url' : 'base64').replace(/=/g, '');
    return s.slice(0, len);
  };
  const short = [
    'AKIAIOSFODNN7EXAMPLE', 'ghp_A1b2C3d4E5f6G7h8I9j0', 'github_pat_11ABCDEFG0123456789abcdef', 'glpat-abcdefghijklmnop1234',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'sk_live_abcdefghijklmnop1234', 'xoxb-1234567890-abcdefghij',
    'https://hooks.slack.com/services/T000/B000/XXXXXXXX', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
    'Authorization: Bearer abcdefghijklmnop1234', 'bearer abcdefghijklmnop1234', 'postgres://admin:Pa55word@db.internal',
    'aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX', 'DB_PASSWORD=Sup3rS3cret!x', 'password is hunter22x',
  ];
  const secrets = [
    ...short, ...short.map((s) => `"${s}"`), 'api_key="abc def 123"', '"password": "p@ss w0rd"', "'secret'='abcdefgh'", `ghp_${'A1b2C3d4'.repeat(400)}`,
  ];
  for (const len of [1024, 4096, 8192]) {
    const key = b64(len);
    const pem = `-----BEGIN PRIVATE KEY-----\n${key.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
    secrets.push(`private_key="${key}"`, `private_key=${key}`, `"client_secret": '${key}'`, `TOKEN is ${key}`, pem, b64(len, true));
  }
  // Where a secret is placed around the cut at WINDOW: starting or ending within 3 of it, crossing
  // it at every offset (every `step`-th, or 9 places for a long one), and ending near the edges of
  // what a window reads (2048 either side of the cut). `step` 0: only starting or ending at the cut.
  const offsets = (L, step) => {
    const at = new Set();
    for (let k = -3; k <= 3; k++) at.add(WINDOW + k).add(WINDOW + k - L);
    if (step) {
      for (let s = WINDOW - L - 3; s <= WINDOW + 3; s += L < 80 ? step : Math.ceil(L / 8)) at.add(s);
      for (const d of [-2048, 2048]) for (let k = -1; k <= 1; k++) at.add(WINDOW + d + k).add(WINDOW + d + k - L);
    }
    return [...at].filter((s) => s >= 16);
  };
  // Minified JSON (quotes every few characters), a log line of words, and one long run with no
  // whitespace or quote past the window's end (so the window cannot end on a break).
  const json = (n) => '"note":"ordinary-wording-in-a-log-line",'.repeat(n / 40 + 1).slice(0, n);
  const words = (n) => 'ordinary-wording-in-a-long-log-line '.repeat(n / 36 + 1).slice(0, n);
  const fillers = [
    [1, (start) => [`{${json(start - 2)},`, `,${json(4096)}}`]],
    [6, (start) => [`${words(start - 1)} `, ` ${words(4096)}`]],
    [0, (start) => [`{"log":"${'x'.repeat(start - 9)},`, `,${'y'.repeat(3 * WINDOW)}"}`]],
  ];
  for (const sec of secrets) {
    const want = maskSecrets(sec);
    assert.notEqual(want, sec, sec);
    for (const [step, fill] of fillers) {
      for (const start of offsets(sec.length, step)) {
        const [pre, post] = fill(start);
        const s = pre + sec + post;
        assert.equal(maskSecrets(s), pre + want + post, `${sec.slice(0, 16)} (${sec.length}) at ${start}`);
        assert.equal(findSecret(s), true, `${sec.slice(0, 16)} (${sec.length}) at ${start}`);
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
