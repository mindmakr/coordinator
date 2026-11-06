// Round 3 of the c11 review: webhook flood, resync, and caps on what one run log can make the App write.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { readLog } from '../src/ingest.mjs';
import { CAPS } from '../src/trail.mjs';
import { appendEvent, makeRun, startApp, stateFiles } from './helpers.mjs';

const PR = 'https://github.com/acme/web/pull/12';
const MOBILE_PR = 'https://github.com/acme/mobile/pull/5';
const OPTED_IN = { 'coordinator.json': { primary: 'acme/web' } };

async function world({ runs = { r1: makeRun('r1', { prs: [PR, MOBILE_PR] }) } } = {}) {
  let clock = Date.parse('2026-11-06T12:00:00Z');
  const t = await startApp({ now: () => clock });
  t.tick = (ms) => { clock += ms; };
  t.gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles(runs, { repos: ['acme/mobile'] }) });
  t.gh.addRepo('acme/mobile', { id: 71, installationId: 7, defaultFiles: OPTED_IN });
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  return t;
}
const note = (buf, text) => appendEvent(buf, 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'info', text, at: '2026-11-06T10:00:00.000Z' }] }] });
const bump = (buf) => appendEvent(buf, 'unit.reset', { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'status'], value: 'stopped' }] }, 'u1');

test('a flood of wrongly signed deliveries from a shared address never blocks a correctly signed one', async () => {
  const t = await world();
  const post = (body, sig) => fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig } });
  try {
    let last;
    for (let i = 0; i < 40; i++) last = await post('{"zen":"x"}', `sha256=${'0'.repeat(64)}`);
    assert.equal(last.status, 429, 'the refused ones are limited');
    const good = '{"zen":"ours"}';
    const r = await post(good, `sha256=${createHmac('sha256', t.cfg.github.webhookSecret).update(good).digest('hex')}`);
    assert.equal(r.status, 200, 'ours still gets through');
  } finally { await t.close(); }
});

test('the periodic resync picks up a push whose webhook never arrived', async () => {
  const log = makeRun('r1');
  const t = await world({ runs: { r1: log } });
  try {
    await t.app.resyncAll();
    assert.equal((await t.db.runs(7, 70))[0].seq, 7);
    t.gh.setFiles('acme/web', stateFiles({ r1: note(log, 'later') }, { repos: ['acme/mobile'] })); // no delivery
    await t.app.resyncAll();
    assert.equal((await t.db.runs(7, 70))[0].seq, 8, 'healed without a webhook');
  } finally { await t.close(); }
});

test('a run with more than 50 units is refused at ingest', async () => {
  const base = makeRun('r1');
  const unit = readLog('r1', base).state.units[0];
  let buf = base;
  for (let i = 2; i <= 51; i++) buf = appendEvent(buf, 'unit.add', { ops: [{ op: 'push', path: ['units'], values: [{ ...unit, id: `u${i}` }] }] }, `u${i}`);
  assert.match(readLog('r1', buf).error, /51 units; at most 50/);
});

test('comment writes per installation are capped; the rest wait for a later sync', async () => {
  const keep = CAPS.commentWritesPerInstallation;
  CAPS.commentWritesPerInstallation = 1;
  try {
    const t = await world();
    try {
      await t.app.ingest.syncInstallation(7);
      const written = () => ['acme/web#12', 'acme/mobile#5'].filter((k) => (t.gh.comments.get(k) ?? []).length).length;
      assert.equal(written(), 1, 'one write, one deferred');
      t.tick(CAPS.windowMs + 1);
      await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' }, { force: true });
      assert.equal(written(), 2, 'the deferred one lands later');
    } finally { await t.close(); }
  } finally { CAPS.commentWritesPerInstallation = keep; }
});

test('consent withdrawn after a comment exists: no further edits there, once the 60 s consent check expires', async () => {
  const log = makeRun('r1', { prs: [PR, MOBILE_PR] });
  const t = await world({ runs: { r1: log } });
  try {
    await t.app.ingest.syncInstallation(7);
    const mobile = t.gh.comments.get('acme/mobile#5')[0];
    const before = mobile.body;
    t.gh.repos.get('acme/mobile').defaultFiles = { 'coordinator.json': { primary: 'acme/other' } };
    t.tick(61_000);
    t.gh.setFiles('acme/web', stateFiles({ r1: bump(log) }, { repos: ['acme/mobile'] }));
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
    assert.match(t.gh.comments.get('acme/web#12')[0].body, /\*\*State:\*\* stopped/, 'the state repo is still kept current');
    assert.equal(t.gh.comments.get('acme/mobile#5')[0].body, before, 'the withdrawn repo is left alone');
    assert.equal(t.gh.calls.some((c) => c[0] === 'updateComment' && c[2] === mobile.id), false);
  } finally { await t.close(); }
});
