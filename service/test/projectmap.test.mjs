import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMap } from '../src/ingest.mjs';
import { liveCtx } from '../../skills/coordinator/scripts/lib/hud.mjs';
import { makeRun, scripts, signIn, startApp, stateFiles } from './helpers.mjs';

const made = {};
const log = makeRun('r1', { mapOut: made, touches: ['src/a.ts', 'docs/notes.md'] });
const mapFiles = (map) => ({ ...stateFiles({ r1: log, r2: makeRun('r2') }), 'runs/r1/map/events.jsonl': map });

async function world(map = made.map) {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: mapFiles(map) });
  t.gh.addUser('tok-reader', { id: 1, login: 'reader', read: ['acme/web'] });
  t.gh.addUser('tok-out', { id: 2, login: 'outsider', read: [] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  t.cookie = await signIn(t, 'reader');
  t.get = async (p, cookie = t.cookie) => { const r = await fetch(`${t.base}${p}`, { headers: { Cookie: cookie }, redirect: 'manual' }); return { status: r.status, html: await r.text(), csp: r.headers.get('content-security-policy') }; };
  return t;
}

test('readMap replays a pushed map with the skill code and refuses a broken one', () => {
  const ok = readMap(made.map);
  assert.equal(ok.error, undefined, ok.error);
  assert.deepEqual(ok.map.modules.map((m) => m.id), ['src/a.ts', 'src/b.ts']);
  const lines = made.map.toString('utf8').trim().split('\n');
  assert.match(readMap(Buffer.from(`${[lines[0], ...lines.slice(2)].join('\n')}\n`)).error, /gap/);
  const tampered = lines.map((l) => l.replace('src/b.ts', 'src/c.ts')).join('\n');
  assert.ok(readMap(Buffer.from(`${tampered}\n`)).error, 'a changed record misses the digest');
});

test('the project map page renders from the pushed log, linked from the run header next to Maps', async () => {
  const t = await world();
  try {
    const page = await t.get('/r/acme/web/run/r1/map');
    assert.equal(page.status, 200);
    assert.match(page.html, /Project map · project/);
    assert.match(page.html, /src\/a\.ts/);
    assert.match(page.html, /env:API_TOKEN_NAME/);
    const sc = scripts(page.html, page.csp);
    assert.ok(sc.tags === 2 && sc.tagged, 'only the theme and panel scripts, by this response\'s nonce; run text is escaped');
    const run = await t.get('/r/acme/web/run/r1');
    assert.match(run.html, /href="\/r\/acme\/web\/run\/r1\/map">Project map →/);
    // The tab row is runTabs, as on the local dashboard: the same tabs in the same order, Project map last.
    const tabs = (html) => [.../<nav class="tabs" aria-label="Pages">(.*?)<\/nav>/.exec(html)[1].matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2], m[1]]);
    const B = '/r/acme/web/run/r1';
    const local = liveCtx({ token: 't', nonce: 'n' }, 'r1').pages.filter((p) => p.tab !== false).map((p) => p.label);
    assert.deepEqual(tabs(run.html).map(([l]) => l), local, 'the local run page\'s tabs, in order');
    assert.deepEqual(tabs(run.html), [['Overview', B], ['Units', `${B}#unit-list`], ['Maps', `${B}/maps`], ['Report', `${B}/report`], ['Retro', `${B}/retro`], ['Project map', `${B}/map`]]);
    assert.deepEqual(tabs(page.html), tabs(run.html), 'the map page has the same row');
    assert.match(page.html, /<a href="\/r\/acme\/web\/run\/r1\/map" aria-current="page">Project map<\/a>/);
    // A run that pushed no map has no link and no page.
    assert.equal((await t.get('/r/acme/web/run/r2/map')).status, 404);
    assert.equal((await t.get('/r/acme/web/run/r2')).html.includes('Project map'), false);
    assert.equal((await t.get('/r/acme/web/run/r1/nope')).status, 404);
    // Access rules are the same as every page.
    assert.equal((await t.get('/r/acme/web/run/r1/map', await signIn(t, 'out'))).status, 404);
    assert.equal((await t.get('/r/acme/web/run/r1/map', '')).status, 302);
  } finally { await t.close(); }
});

test('the hosted map lists the files each unit touched, linked to the unit', async () => {
  const t = await world();
  try {
    const page = await t.get('/r/acme/web/run/r1/map');
    const panel = /<details class="panel" data-d="touched"[^>]*>(.*?)<\/details>/s.exec(page.html)?.[1] ?? '';
    assert.match(panel, /<h2>Touched by this run<\/h2><span class="count">2<\/span>/);
    assert.match(panel, /<a class="ulink" href="\/r\/acme\/web\/run\/r1\/unit\/u1">u1<\/a>/, 'the unit links to its page here');
    assert.match(panel, /title="docs\/notes\.md"/); assert.match(panel, /title="src\/a\.ts"/);
    assert.ok(panel.indexOf('docs/notes.md') < panel.indexOf('src/a.ts'), 'files sorted');
  } finally { await t.close(); }
});

test('a broken map log keeps the last good map; one that never replayed says why', async () => {
  const t = await world();
  try {
    t.gh.setFiles('acme/web', mapFiles(Buffer.from('{"v":1}\n')));
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
    const page = await t.get('/r/acme/web/run/r1/map');
    assert.equal(page.status, 200);
    assert.match(page.html, /src\/a\.ts/, 'last good map');
    assert.match(page.html, /latest map log was refused/);
  } finally { await t.close(); }
  const bad = await world(Buffer.from('not json\n'));
  try {
    const page = await bad.get('/r/acme/web/run/r1/map');
    assert.equal(page.status, 200);
    assert.match(page.html, /not readable/);
    assert.match(page.html, /not JSON/);
  } finally { await bad.close(); }
});
