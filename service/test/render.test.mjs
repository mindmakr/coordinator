import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRun, signIn, startApp, stateFiles, XSS } from './helpers.mjs';

async function world() {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1'), r2: makeRun('r2', { closed: true }) }) });
  t.gh.addUser('tok-reader', { id: 1, login: 'reader', read: ['acme/web'] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  t.cookie = await signIn(t, 'reader');
  t.get = (path, cookie = t.cookie) => fetch(`${t.base}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  return t;
}

const PAGES = ['/', '/r/acme/web', '/r/acme/web/run/r1', '/r/acme/web/run/r1/unit/u1', '/r/acme/web/coordinator', '/r/acme/web/run/r2'];

test('every page escapes run text, carries no script, and sends a strict CSP and no-store', async () => {
  const t = await world();
  try {
    for (const p of PAGES) {
      const r = await t.get(p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      assert.equal(/<script/i.test(html), false, `${p}: no script tag at all`);
      assert.equal(html.includes('<img src=x'), false, `${p}: no raw markup from the run`);
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
    }
    const run = await (await t.get('/r/acme/web/run/r1')).text();
    assert.match(run, /Totals match &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/, 'the goal, escaped');
    assert.match(run, /Which total\?/, 'the open question shows');
    assert.match(run, /<fieldset disabled>/, 'a reader sees the answer form disabled');
    assert.match(run, /Only people who can push to acme\/web can answer or add notes/, 'with the reason');
    assert.match(run, /href="\/r\/acme\/web\/run\/r1\/unit\/u1"/, 'units link to their pages here');
    const unit = await (await t.get('/r/acme/web/run/r1/unit/u1')).text();
    assert.match(unit, /stale cache/);
    assert.match(unit, /still wrong &lt;script&gt;/);
    const list = await (await t.get('/r/acme/web')).text();
    assert.match(list, /r1/); assert.match(list, /r2/);
    assert.equal(list.includes(XSS), false);
  } finally { await t.close(); }
});

test('a missing run or unit, or an unsafe id, is a 404', async () => {
  const t = await world();
  try {
    for (const p of ['/r/acme/web/run/nope', '/r/acme/web/run/r1/unit/u9', '/r/acme/web/run/..%2F..', '/r/acme/web/run/%3Cx%3E', '/r/acme/web/other', '/r/a%2Fb/c']) {
      assert.equal((await t.get(p)).status, 404, p);
    }
  } finally { await t.close(); }
});

test('sign-in: state cookie is HttpOnly and SameSite; a wrong or missing state is refused', async () => {
  const t = await startApp();
  t.gh.addUser('tok-x', { id: 9, login: 'x' });
  try {
    const start = await fetch(`${t.base}/login?next=/r/acme/web`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const c = start.headers.get('set-cookie');
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.match(c, /Max-Age=600/);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    assert.ok(state.length >= 32);
    const cookie = c.split(';')[0];
    let r = await fetch(`${t.base}/auth/callback?code=x&state=forged`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(r.status, 400, 'wrong state');
    r = await fetch(`${t.base}/auth/callback?code=x&state=${state}`, { redirect: 'manual' });
    assert.equal(r.status, 400, 'no state cookie: started elsewhere');
    assert.equal(t.gh.calls.filter((x) => x[0] === 'exchangeCode').length, 0, 'no code exchanged');
    r = await fetch(`${t.base}/auth/callback?code=x&state=${state}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/r/acme/web', 'back where the person started');
    const session = r.headers.getSetCookie().find((x) => x.startsWith('coordinator='));
    assert.match(session, /HttpOnly/); assert.match(session, /SameSite=Lax/); assert.match(session, /Path=\//);
  } finally { await t.close(); }
});

test('on https the cookies are Secure and __Host- prefixed, and HSTS is sent', async () => {
  const t = await startApp({ over: { secure: true, baseUrl: 'https://coordinator.example' } });
  try {
    const r = await fetch(`${t.base}/login`, { redirect: 'manual' });
    assert.match(r.headers.get('set-cookie'), /^__Host-coordinator-oauth=.*; Secure$/);
    assert.match(r.headers.get('strict-transport-security'), /max-age=/);
  } finally { await t.close(); }
});

test('POSTs need this origin and the session CSRF token', async () => {
  const t = await world();
  const post = (path, body, origin = t.cfg.baseUrl) => fetch(`${t.base}${path}`, { method: 'POST', body, redirect: 'manual', headers: { Cookie: t.cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
  try {
    const page = await (await t.get('/r/acme/web')).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
    assert.equal((await post('/r/acme/web/sync', `csrf=${csrf}`, 'https://evil.example')).status, 403, 'other origin');
    assert.equal((await post('/r/acme/web/sync', 'csrf=nope')).status, 403, 'wrong token');
    const ok = await post('/r/acme/web/sync', `csrf=${csrf}`);
    assert.equal(ok.status, 303);
    assert.equal((await post('/logout', 'csrf=nope')).status, 403);
    const out = await post('/logout', `csrf=${csrf}`);
    assert.equal(out.status, 303);
    assert.match(out.headers.get('set-cookie'), /^coordinator=; .*Max-Age=0/);
    assert.equal((await t.get('/r/acme/web')).status, 302, 'signed out: the old cookie no longer works');
  } finally { await t.close(); }
});

test('a run whose log never validated is listed as unreadable, with the reason, and has no page', async () => {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1'), bad: Buffer.from('{"v":1}\n') }) });
  t.gh.addUser('tok-reader', { id: 1, login: 'reader', read: ['acme/web'] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  const cookie = await signIn(t, 'reader');
  try {
    const list = await (await fetch(`${t.base}/r/acme/web`, { headers: { Cookie: cookie } })).text();
    assert.match(list, /<h2>Unreadable<\/h2>/);
    assert.match(list, /unknown event kind/);
    assert.equal((await fetch(`${t.base}/r/acme/web/run/bad`, { headers: { Cookie: cookie } })).status, 404);
  } finally { await t.close(); }
});
