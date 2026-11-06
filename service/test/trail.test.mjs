import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { boardConfig } from '../src/board.mjs';
import { appendEvent, makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

const PR = 'https://github.com/acme/web/pull/12';
const MOBILE_PR = 'https://github.com/acme/mobile/pull/5';
const comments = (t, key) => t.gh.comments.get(key) ?? [];

// The project: acme/web (state) lists acme/mobile, and acme/mobile names acme/web as its primary.
const PROJECT = { repos: ['acme/mobile'] };
const OPTED_IN = { 'coordinator.json': { primary: 'acme/web' } };

async function world({ runOpts = {}, config = PROJECT, webPrivate = true, mobileFiles = OPTED_IN, extraRepos = [] } = {}) {
  const t = await startApp();
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, private: webPrivate, files: stateFiles({ r1: makeRun('r1', { prs: [PR, MOBILE_PR], issues: ['acme/elsewhere#3', ...extraRepos.map((x) => x.ref)], ...runOpts }) }, config) });
  t.gh.addRepo('acme/mobile', { id: 71, installationId: 7, private: true, defaultFiles: mobileFiles });
  for (const x of extraRepos) t.gh.addRepo(x.name, { id: x.id, installationId: 7, defaultFiles: x.defaultFiles ?? {} });
  t.gh.addRepo('other/lib', { id: 90, installationId: 9 });
  t.gh.addUser('tok-reader', { id: 1, login: 'reader', read: ['acme/web'] });
  t.gh.addUser('tok-both', { id: 2, login: 'both', read: ['acme/web', 'acme/mobile'] });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  t.hook = (event, payload, delivery) => {
    const body = JSON.stringify(payload);
    return fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(body).digest('hex')}` } });
  };
  return t;
}

test('tracker comments: one per unit on each linked issue or PR of this installation, with a comments-only token', async () => {
  const t = await world();
  try {
    const web = comments(t, 'acme/web#12'); const mobile = comments(t, 'acme/mobile#5');
    assert.equal(web.length, 1); assert.equal(mobile.length, 1);
    assert.ok(web[0].body.startsWith('<!-- coordinator:tracker run=r1 unit=u1 -->'));
    assert.match(web[0].body, /\*\*State:\*\* needs you|\*\*State:\*\* building/);
    assert.match(web[0].body, /`Totals`/, 'run text in code spans');
    assert.match(web[0].body, /http:\/\/localhost:3999\/r\/acme\/web\/run\/r1\/unit\/u1/);
    assert.equal(comments(t, 'acme/elsewhere#3').length, 0, 'a repo the App is not installed on is never written');
    const tokenCalls = t.gh.calls.filter((c) => c[0] === 'installationToken' && c[2]?.issues === 'write');
    assert.ok(tokenCalls.length >= 1);
    assert.deepEqual(tokenCalls[0][2], { issues: 'write', pull_requests: 'write', metadata: 'read' });
    assert.equal(t.gh.calls.some((c) => c[0] === 'installationToken' && c[2]?.contents === 'write'), false, 'never contents: write');
  } finally { await t.close(); }
});

test('tracker detail: gap and cause only in the private state repo; status only anywhere else', async () => {
  const t = await world();
  try {
    assert.match(comments(t, 'acme/web#12')[0].body, /stale cache/, 'private state repo: detail');
    const mobile = comments(t, 'acme/mobile#5')[0].body;
    assert.equal(mobile.includes('stale cache'), false, 'another repo: status only');
    assert.equal(mobile.includes('still wrong'), false);
  } finally { await t.close(); }
  const pub = await world({ webPrivate: false });
  try {
    assert.equal(comments(pub, 'acme/web#12')[0].body.includes('stale cache'), false, 'public state repo: status only');
  } finally { await pub.close(); }
});

test('tracker comments are edited in place, never re-sent unchanged, re-made if deleted, and adopted if the record is lost', async () => {
  const t = await world();
  try {
    const first = comments(t, 'acme/web#12')[0];
    const mark = t.gh.calls.length;
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' }, { force: true });
    assert.equal(t.gh.count('createComment', mark) + t.gh.count('updateComment', mark), 0, 'same text: nothing sent');

    // The run moves on: the same comment is edited.
    const files = stateFiles({ r1: appendEvent(makeRun('r1', { prs: [PR, MOBILE_PR] }), 'unit.reset', { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'status'], value: 'stopped' }] }, 'u1') });
    t.gh.setFiles('acme/web', files);
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
    assert.equal(comments(t, 'acme/web#12').length, 1);
    assert.equal(comments(t, 'acme/web#12')[0].id, first.id);
    assert.match(comments(t, 'acme/web#12')[0].body, /\*\*State:\*\* stopped/);

    // Someone deletes it: a new one is made.
    t.gh.comments.set('acme/web#12', []);
    const files2 = stateFiles({ r1: appendEvent(files['runs/r1/events.jsonl'], 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'info', text: 'x', at: '2026-11-06T10:00:00.000Z' }] }] }) });
    t.gh.setFiles('acme/web', files2);
    await t.db.putTracker(7, { refKey: 'acme/web#12', runId: 'r1', unitId: 'u1', bodySha: 'stale' });
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' }, { force: true });
    assert.equal(comments(t, 'acme/web#12').length, 1, 're-made');

    // The service's record is lost (a new database): its own comment is found and adopted, not duplicated.
    await t.db.putTracker(7, { refKey: 'acme/web#12', runId: 'r1', unitId: 'u1', commentId: null, bodySha: 'lost' });
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' }, { force: true });
    assert.equal(comments(t, 'acme/web#12').length, 1, 'adopted');
  } finally { await t.close(); }
});

test('coordinator.json "trackers": false turns the comments off for that repo', async () => {
  const t = await world({ config: { ...PROJECT, trackers: false } });
  try { assert.equal(comments(t, 'acme/web#12').length, 0); } finally { await t.close(); }
});

test('merge and check webhooks feed the timeline and the tracker comment', async () => {
  const t = await world();
  try {
    const repo = { id: 70, full_name: 'acme/web', private: true };
    let r = await t.hook('pull_request', { action: 'closed', installation: { id: 7 }, repository: repo, pull_request: { number: 12, merged: true, merged_at: '2026-11-06T11:00:00Z' } }, 'p1');
    assert.equal(r.status, 202);
    r = await t.hook('check_suite', { action: 'completed', installation: { id: 7 }, repository: repo, check_suite: { id: 55, conclusion: 'failure', head_sha: 'abc', updated_at: '2026-11-06T10:30:00Z', pull_requests: [{ number: 12 }] } }, 'c1');
    assert.equal(r.status, 202);
    r = await t.hook('pull_request', { action: 'opened', installation: { id: 7 }, repository: repo, pull_request: { number: 12 } }, 'p0');
    assert.match(await r.text(), /ignored/);
    await t.app.idle();
    const body = comments(t, 'acme/web#12')[0].body;
    assert.match(body, /`PR acme\/web#12 merged`/);
    assert.match(body, /`PR acme\/web#12 checks failure`/);

    const cookie = await signIn(t, 'reader');
    const run = await (await fetch(`${t.base}/r/acme/web/run/r1`, { headers: { Cookie: cookie } })).text();
    assert.match(run, /k-merge[^>]*>merged/);
    assert.match(run, /acme\/web#12<\/a> merged \(GitHub\)/, 'the PR, linked');
    assert.match(run, /checks red/);
    const unit = await (await fetch(`${t.base}/r/acme/web/run/r1/unit/u1`, { headers: { Cookie: cookie } })).text();
    assert.match(unit, /acme\/web#12<\/a> merged/);

    // A redelivery records nothing new.
    const before = (await t.db.ghEvents(7, ['acme/web#12'])).length;
    await t.hook('pull_request', { action: 'closed', installation: { id: 7 }, repository: repo, pull_request: { number: 12, merged: true, merged_at: '2026-11-06T11:00:00Z' } }, 'p1');
    await t.app.idle();
    assert.equal((await t.db.ghEvents(7, ['acme/web#12'])).length, before);
  } finally { await t.close(); }
});

test('events from a linked repo show only to viewers who can read that repo too', async () => {
  const t = await world();
  try {
    await t.hook('pull_request', { action: 'closed', installation: { id: 7 }, repository: { id: 71, full_name: 'acme/mobile' }, pull_request: { number: 5, merged: true, merged_at: '2026-11-06T11:00:00Z' } }, 'm1');
    await t.app.idle();
    const page = async (who) => (await fetch(`${t.base}/r/acme/web/run/r1`, { headers: { Cookie: await signIn(t, who) } })).text();
    assert.equal(/mobile#5<\/a> merged/.test(await page('reader')), false, 'reader cannot read acme/mobile');
    assert.match(await page('both'), /mobile#5<\/a> merged/);
  } finally { await t.close(); }
});

test('board: the Run and Unit state fields are made once and set on cards already on the board; Status follows the map', async () => {
  const config = { board: { owner: 'acme', number: 3, status: { building: 'In progress', 'needs you': 'In progress', passed: 'Done' } } };
  const t = await startApp();
  t.gh.makeBoard({ items: ['acme/web#12'] });
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { prs: [PR, 'https://github.com/acme/web/pull/13'] }) }, config) });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  try {
    await t.app.ingest.syncInstallation(7);
    const names = t.gh.board.project.fields.nodes.map((f) => f.name);
    assert.deepEqual(names.sort(), ['Run', 'Status', 'Unit state']);
    const set = t.gh.board.values.filter(([item]) => item === 'I-acme/web#12');
    assert.deepEqual(set.find(([, f]) => f === 'F-Run')[2], { text: 'r1' });
    assert.ok(set.find(([, f]) => f === 'F-Unit state')[2].singleSelectOptionId.startsWith('o-'));
    assert.deepEqual(set.find(([, f]) => f === 'F-status')[2], { singleSelectOptionId: 'o-prog' });
    assert.equal(t.gh.board.values.some(([item]) => item === 'I-acme/web#13'), false, 'a card not on the board is left alone');
    const boardToken = t.gh.calls.find((c) => c[0] === 'installationToken' && c[2]?.organization_projects);
    assert.deepEqual(boardToken[2], { organization_projects: 'write', issues: 'read', pull_requests: 'read', metadata: 'read' });
    const n = t.gh.board.values.length;
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' }, { force: true });
    assert.equal(t.gh.board.values.length, n, 'unchanged state: no board writes');
    assert.equal(t.gh.calls.filter((c) => c[0] === 'graphql' && c[1] === 'CoordinatorField').length, 2, 'fields made once');
  } finally { await t.close(); }
});

test('boardConfig accepts only a well-formed board', () => {
  assert.equal(boardConfig(null), null);
  assert.equal(boardConfig({ board: { owner: 'acme', number: '3' } }), null);
  assert.equal(boardConfig({ board: { owner: '-bad', number: 3 } }), null);
  assert.deepEqual(boardConfig({ board: { owner: 'acme', number: 3, status: { passed: 'Done', bogus: 'x', stopped: 7 } } }), { owner: 'acme', number: 3, status: { passed: 'Done' } });
});

test('maps page renders; evidence files show as kept locally; the needs-you hint points to the chat', async () => {
  const t = await world({ runOpts: { file: true } });
  try {
    const cookie = await signIn(t, 'reader');
    const get = async (p) => { const r = await fetch(`${t.base}${p}`, { headers: { Cookie: cookie } }); return { status: r.status, html: await r.text() }; };
    const maps = await get('/r/acme/web/run/r1/maps');
    assert.equal(maps.status, 200);
    assert.match(maps.html, /<svg/);
    assert.match(maps.html, /Mind map/);
    assert.equal(/<script/i.test(maps.html), false);
    assert.match(maps.html, /href="\/r\/acme\/web\/run\/r1\/unit\/u1"/, 'map nodes open unit pages here');
    const run = await get('/r/acme/web/run/r1');
    assert.match(run.html, /href="\/r\/acme\/web\/run\/r1\/maps"/);
    assert.match(run.html, /answer in the chat with the lead/);
    assert.equal(run.html.includes('run.mjs serve'), false);
    const unit = await get('/r/acme/web/run/r1/unit/u1');
    assert.match(unit.html, /file kept locally/);
    assert.equal(/href="(null|#evidence-is-local)"/.test(unit.html + maps.html), false, 'no dead links');
    assert.equal((await get('/r/acme/web/nope')).status, 404, 'an unknown repo page');
  } finally { await t.close(); }
});

test('writes stay in the project: an installation repo a run links without both sides agreeing gets no comment and no board change', async () => {
  const config = { ...PROJECT, repos: ['acme/mobile', 'acme/listed'], board: { owner: 'acme', number: 3 } };
  const extra = [
    { name: 'acme/secret', id: 80, ref: 'acme/secret#5', defaultFiles: { 'coordinator.json': { primary: 'acme/web' } } }, // agrees, but not listed
    { name: 'acme/listed', id: 81, ref: 'acme/listed#6' }, // listed, but never agreed
  ];
  const t = await startApp();
  t.gh.makeBoard({ items: ['acme/secret#5', 'acme/listed#6', 'acme/mobile#5', 'acme/web#12'] });
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { prs: [PR, MOBILE_PR], issues: extra.map((x) => x.ref) }) }, config) });
  t.gh.addRepo('acme/mobile', { id: 71, installationId: 7, defaultFiles: OPTED_IN });
  for (const x of extra) t.gh.addRepo(x.name, { id: x.id, installationId: 7, defaultFiles: x.defaultFiles ?? {} });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  try {
    await t.app.ingest.syncInstallation(7);
    assert.equal(comments(t, 'acme/secret#5').length, 0, 'not listed: no comment');
    assert.equal(comments(t, 'acme/listed#6').length, 0, 'listed without consent: no comment');
    assert.equal(comments(t, 'acme/web#12').length, 1, 'the state repo');
    assert.equal(comments(t, 'acme/mobile#5').length, 1, 'a repo that opted in');
    const touched = new Set(t.gh.board.values.map(([item]) => item));
    assert.equal(touched.has('I-acme/secret#5') || touched.has('I-acme/listed#6'), false, 'no board change outside the project');
    assert.ok(touched.has('I-acme/web#12') && touched.has('I-acme/mobile#5'));
  } finally { await t.close(); }
});

test('a repo that withdraws (its primary no longer names the state repo) gets no more writes', async () => {
  const t = await world({ mobileFiles: { 'coordinator.json': { primary: 'acme/other' } } });
  try { assert.equal(comments(t, 'acme/mobile#5').length, 0); } finally { await t.close(); }
});
