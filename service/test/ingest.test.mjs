import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { ingester, readLog } from '../src/ingest.mjs';
import { appendEvent, fakeGitHub, makeRun, stateFiles } from './helpers.mjs';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const REPO = { id: 70, fullName: 'acme/web' };

function setup(runs) {
  const gh = fakeGitHub(); const db = guard(memoryDb());
  gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles(runs) });
  return { gh, db, ingest: ingester({ db, gh }), prep: async () => { await db.upsertInstallation({ id: 7, account: 'acme' }); await db.upsertRepo({ installationId: 7, ...REPO }); } };
}

const good = makeRun('r1');
const other = makeRun('r2', { closed: true });

test('readLog: a valid log replays to the run, with secrets masked a second time', () => {
  const withSecret = appendEvent(good, 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'info', text: `token ${SECRET}`, at: '2026-11-06T10:00:00.000Z' }] }] });
  const r = readLog('r1', withSecret);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.seq, 8);
  assert.equal(r.state.id, 'r1');
  assert.equal(JSON.stringify(r.state).includes(SECRET), false);
  assert.match(JSON.stringify(r.state), /\[redacted\]/);
});

test('readLog: every malformed log is refused with a reason, never thrown', () => {
  const lines = good.toString('utf8').trim().split('\n');
  const bad = {
    'torn last line': Buffer.from(good.toString('utf8').slice(0, -5)),
    'not JSON': Buffer.from(`${lines[0]}\n{nope\n`),
    'unknown kind': appendEvent(good, 'run.explode', { ops: [{ op: 'set', path: ['x'], value: 1 }] }),
    'seq gap': Buffer.from(`${lines[0]}\n${lines[2]}\n`),
    'schema break': appendEvent(good, 'note', { ops: [{ op: 'set', path: ['__proto__'], value: 1 }] }),
    'empty': Buffer.alloc(0),
  };
  for (const [what, buf] of Object.entries(bad)) {
    const r = readLog('r1', buf);
    assert.ok(r.error, `${what}: refused`);
    assert.equal(r.state, undefined, what);
  }
  assert.match(readLog('r9', good).error, /describes run "r1", not r9/, 'a log under another run folder');
});

test('sync: stores each run, is idempotent, keeps the last good state when a log goes bad, drops removed runs', async () => {
  const t = setup({ r1: good, r2: other });
  await t.prep();
  let out = await t.ingest.syncRepo(7, REPO);
  assert.deepEqual(out.updated.sort(), ['r1', 'r2']);
  let runs = await t.db.runs(7, 70);
  assert.deepEqual(runs.map((r) => [r.runId, r.seq, !!r.state, r.error]), [['r1', 7, true, null], ['r2', 8, true, null]]);

  const blobs = () => t.gh.calls.filter((c) => c[0] === 'blob').length;
  const before = blobs();
  out = await t.ingest.syncRepo(7, REPO);
  assert.equal(out.unchanged, true, 'same tip: nothing read');
  assert.equal(blobs(), before);
  out = await t.ingest.syncRepo(7, REPO, { force: true });
  assert.deepEqual(out.updated.sort(), ['r1', 'r2'], 'forced: read again');
  assert.deepEqual((await t.db.runs(7, 70)).map((r) => r.seq), [7, 8], 'with the same result');

  // r1's log is replaced by a broken one; r2 grows by one valid event.
  t.gh.setFiles('acme/web', stateFiles({ r1: Buffer.from('{"broken":\n'), r2: appendEvent(other, 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'info', text: 'later', at: '2026-11-06T10:00:00.000Z' }] }] }) }));
  out = await t.ingest.syncRepo(7, REPO);
  assert.deepEqual(out.failed, ['r1']);
  assert.deepEqual(out.updated, ['r2']);
  runs = await t.db.runs(7, 70);
  const r1 = runs.find((r) => r.runId === 'r1');
  assert.equal(r1.seq, 7, 'the last good copy is kept');
  assert.equal(r1.state.id, 'r1');
  assert.match(r1.error, /not JSON/);
  assert.equal(runs.find((r) => r.runId === 'r2').seq, 9);

  t.gh.setFiles('acme/web', stateFiles({ r2: other }));
  await t.ingest.syncRepo(7, REPO);
  assert.deepEqual((await t.db.runs(7, 70)).map((r) => r.runId), ['r2'], 'a run gone from the branch is gone here');
});

test('sync: a branch without the state marker is refused; a deleted branch empties the repo', async () => {
  const t = setup({ r1: good });
  await t.prep();
  await t.ingest.syncRepo(7, REPO);
  const { '.coordinator-state': _, ...noMarker } = stateFiles({ r1: good });
  t.gh.setFiles('acme/web', noMarker);
  const out = await t.ingest.syncRepo(7, REPO);
  assert.equal(out.error, 'no marker');
  assert.match((await t.db.repos(7))[0].error, /no coordinator state/);
  t.gh.repos.get('acme/web').files = null;
  await t.ingest.syncRepo(7, REPO);
  assert.equal((await t.db.runs(7, 70)).length, 0);
});

test('sync: an unsafe run folder name is skipped; lessons are read and masked', async () => {
  const files = { ...stateFiles({ r1: good }), 'runs/..evil/events.jsonl': good, 'lessons/lessons.json': Buffer.from(JSON.stringify([{ id: 'l1', tag: 'code', text: `use ${SECRET}`, seen: 1, used: 0 }])) };
  const t = setup({});
  t.gh.setFiles('acme/web', files);
  await t.prep();
  await t.ingest.syncRepo(7, REPO);
  assert.deepEqual((await t.db.runs(7, 70)).map((r) => r.runId), ['r1']);
  const lessons = (await t.db.repos(7))[0].lessons;
  assert.equal(lessons[0].id, 'l1');
  assert.equal(JSON.stringify(lessons).includes(SECRET), false);
});

test('isolation: every repo and run query needs an installation id', async () => {
  const db = guard(memoryDb());
  for (const [name, args] of [['repos', []], ['runs', [70]], ['run', [70, 'r1']], ['putRun', [70, {}]], ['dropRunsExcept', [70, []]], ['setRepoSync', [70, {}]], ['removeRepo', [70]], ['deleteInstallation', []]]) {
    for (const bad of [undefined, null, 0, -1, '7', 1.5]) assert.throws(() => db[name](bad, ...args), /installation id is required/, `${name}(${bad})`);
  }
  // And rows of one installation never show under another.
  await db.upsertInstallation({ id: 1, account: 'a' }); await db.upsertInstallation({ id: 2, account: 'b' });
  await db.upsertRepo({ installationId: 1, id: 70, fullName: 'a/web' });
  await db.putRun(1, 70, { runId: 'r1', eventsSha: 'x', seq: 1, state: { id: 'r1', units: [] }, error: null });
  assert.equal((await db.runs(2, 70)).length, 0);
  assert.equal(await db.run(2, 70, 'r1'), null);
});

test('deeply nested lessons or coordinator.json never stop a sync: runs are stored and the repo names the file', async () => {
  const deep = (n) => Buffer.from(`[${'{"a":'.repeat(n)}1${'}'.repeat(n)}]`);
  const deepObj = (n) => Buffer.from(`${'{"a":'.repeat(n)}1${'}'.repeat(n)}`);
  for (const [path, buf] of [['lessons/lessons.json', deep(100_000)], ['coordinator.json', deepObj(10_000)], ['lessons/lessons.json', deep(80)]]) {
    const t = setup({});
    t.gh.setFiles('acme/web', { ...stateFiles({ r1: good }), [path]: buf });
    await t.prep();
    const out = await t.ingest.syncRepo(7, REPO);
    assert.deepEqual(out.updated, ['r1'], `${path}: the run is stored`);
    const repo = (await t.db.repos(7))[0];
    assert.ok(repo.error.startsWith(`${path}: `), `${path}: named in the sync error (${repo.error})`);
    assert.equal(repo.headSha, out.head, 'the sync is recorded');
  }
});
