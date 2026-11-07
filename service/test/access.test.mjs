import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

async function world(over = {}) {
  let clock = Date.parse('2026-11-06T12:00:00Z');
  const t = await startApp({ now: () => clock, ...over });
  t.tick = (ms) => { clock += ms; };
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
  t.gh.addRepo('acme/secret', { id: 71, installationId: 7, files: stateFiles({ s1: makeRun('s1') }) });
  t.gh.addUser('tok-reader', { id: 1, login: 'reader', read: ['acme/web'] });
  t.gh.addUser('tok-writer', { id: 2, login: 'writer', read: ['acme/web', 'acme/secret'] });
  t.gh.addUser('tok-outsider', { id: 3, login: 'outsider', read: [] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  t.get = (path, cookie) => fetch(`${t.base}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  return t;
}

const PATHS = ['/r/acme/secret', '/r/acme/secret/run/s1', '/r/acme/secret/run/s1/unit/u1', '/r/acme/secret/coordinator'];

test('a reader sees the runs of a repo they can read; an outsider gets 404 everywhere, same as a repo that does not exist', async () => {
  const t = await world();
  try {
    const reader = await signIn(t, 'reader'); const writer = await signIn(t, 'writer'); const outsider = await signIn(t, 'outsider');
    for (const p of ['/r/acme/web', '/r/acme/web/run/r1', '/r/acme/web/run/r1/unit/u1', '/r/acme/web/coordinator']) {
      assert.equal((await t.get(p, reader)).status, 200, `reader ${p}`);
    }
    for (const p of PATHS) {
      assert.equal((await t.get(p, writer)).status, 200, `writer ${p}`);
      assert.equal((await t.get(p, reader)).status, 404, `reader cannot read ${p}`);
      assert.equal((await t.get(p, outsider)).status, 404, `outsider ${p}`);
    }
    const missing = await (await t.get('/r/acme/nothing-here', outsider)).text();
    const hidden = await (await t.get('/r/acme/secret', outsider)).text();
    assert.equal(hidden, missing, 'a private repo and a missing one look the same');
    // The run id as the page would show it (a link or a cell), not two letters a random token may hold.
    assert.doesNotMatch(hidden, /\/run\/s1\b|>s1</);
  } finally { await t.close(); }
});

test('signed out, a repo page sends you to sign in and shows nothing', async () => {
  const t = await world();
  try {
    const r = await t.get('/r/acme/web/run/r1');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login?next=%2Fr%2Facme%2Fweb%2Frun%2Fr1');
    assert.equal(t.gh.calls.filter((c) => c[0] === 'repoAccess').length, 0);
  } finally { await t.close(); }
});

test('the permission answer is cached per person for the TTL, then asked again; losing access shows at the next check', async () => {
  const t = await world();
  try {
    const reader = await signIn(t, 'reader');
    const asked = () => t.gh.calls.filter((c) => c[0] === 'repoAccess' && c[1] === 'tok-reader').length;
    await t.get('/r/acme/web/run/r1', reader); await t.get('/r/acme/web', reader);
    assert.equal(asked(), 1, 'one question within the TTL');
    t.gh.users.get('tok-reader').read.delete('acme/web');
    t.tick(61_000);
    assert.equal((await t.get('/r/acme/web/run/r1', reader)).status, 404, 'access removed on GitHub');
    assert.equal(asked(), 2);
    // Another person's cached "yes" is never used for this one.
    const writer = await signIn(t, 'writer');
    await t.get('/r/acme/web', writer);
    assert.equal(t.gh.calls.filter((c) => c[0] === 'repoAccess' && c[1] === 'tok-writer').length, 1);
  } finally { await t.close(); }
});

test('a repo re-created under the same name is another repo', async () => {
  const t = await world();
  try {
    const reader = await signIn(t, 'reader');
    t.gh.repos.get('acme/web').id = 999;
    assert.equal((await t.get('/r/acme/web', reader)).status, 404);
  } finally { await t.close(); }
});

test('the projects page lists only repos the person can read', async () => {
  const t = await world();
  try {
    const page = await (await t.get('/', await signIn(t, 'reader'))).text();
    assert.match(page, /acme\/web/);
    assert.equal(page.includes('acme/secret'), false);
    const none = await (await t.get('/', await signIn(t, 'outsider'))).text();
    assert.match(none, /No projects yet/);
  } finally { await t.close(); }
});
