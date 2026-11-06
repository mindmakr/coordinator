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
