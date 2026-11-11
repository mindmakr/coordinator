// The person's GitHub token is refreshed with a refresh token that works once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sealer, sessions } from '../src/session.mjs';

const config = { sessionSecret: 's'.repeat(40), secure: false, baseUrl: 'http://x' };
const id = 'A'.repeat(43);
const idHash = createHash('sha256').update(id).digest('hex');
const box = sealer(config.sessionSecret);

function setup({ refresh }) {
  const row = { idHash, userId: 1, login: 'ana', tokenEnc: box.seal('old'), refreshEnc: box.seal('r1'), tokenExpiresAt: Date.now() - 1000, refreshExpiresAt: null };
  const calls = { refresh: 0, dropped: 0 };
  const db = {
    session: async (h) => (h === idHash && row.tokenEnc ? { ...row } : null),
    updateSessionTokens: async (h, t) => { Object.assign(row, t); },
    dropSession: async () => { calls.dropped++; row.tokenEnc = null; },
  };
  const gh = { refresh: async (r) => { calls.refresh++; return refresh(r, row); } };
  return { s: sessions({ db, gh, config }), calls, row };
}
const fresh = (n) => ({ token: `new${n}`, refresh: `r${n + 1}`, expiresAt: Date.now() + 3_600_000, refreshExpiresAt: null });

test('two requests with an expired token share one refresh', async () => {
  const t = setup({
    refresh: async (r) => {
      await new Promise((ok) => setTimeout(ok, 20));
      if (r !== 'r1') throw new Error('bad_refresh_token');
      return fresh(1);
    },
  });
  const [a, b] = await Promise.all([t.s.current({ coordinator: id }), t.s.current({ coordinator: id })]);
  assert.deepEqual(await Promise.all([a.token(), b.token()]), ['new1', 'new1']);
  assert.equal(t.calls.refresh, 1, 'the refresh token is used once');
  assert.equal(t.calls.dropped, 0, 'nobody is signed out');
  assert.equal(box.open(t.row.refreshEnc), 'r2', 'the new refresh token is stored');
});

test('a refresh that another instance won uses the stored tokens', async () => {
  const t = setup({
    refresh: async (r, row) => {
      Object.assign(row, { tokenEnc: box.seal('theirs'), refreshEnc: box.seal('r9'), tokenExpiresAt: Date.now() + 3_600_000 });
      throw new Error('bad_refresh_token');
    },
  });
  const a = await t.s.current({ coordinator: id });
  assert.equal(await a.token(), 'theirs');
  assert.equal(t.calls.dropped, 0);
});

test('a refresh that fails with nothing newer stored signs the session out', async () => {
  const t = setup({ refresh: async () => { throw new Error('bad_refresh_token'); } });
  const a = await t.s.current({ coordinator: id });
  assert.equal(await a.token(), null);
  assert.equal(t.calls.dropped, 1);
});
