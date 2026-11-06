// The same contract for both adapters. Postgres runs when TEST_DATABASE_URL
// is set (docker compose up -d db, see service/README.md); its tables are
// dropped first, so point it at a throwaway database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { ingester } from '../src/ingest.mjs';
import { fakeGitHub, makeRun, stateFiles } from './helpers.mjs';

const PG = process.env.TEST_DATABASE_URL;

async function fresh(kind) {
  if (kind === 'memory') return guard(memoryDb());
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS trackers, gh_events, unit_refs, audit, sessions, deliveries, runs, repos, installations, schema_migrations CASCADE');
  await c.end();
  const { postgresDb } = await import('../src/db/postgres.mjs');
  return guard(await postgresDb(PG, { max: 2 }));
}

for (const kind of ['memory', 'postgres']) {
  test(`${kind}: installations, repos, runs, deliveries and sessions`, { skip: kind === 'postgres' && !PG && 'set TEST_DATABASE_URL to run against Postgres' }, async () => {
    const db = await fresh(kind);
    try {
      await db.upsertInstallation({ id: 7, account: 'acme' });
      await db.upsertInstallation({ id: 8, account: 'other' });
      await db.upsertRepo({ installationId: 7, id: 70, fullName: 'acme/web' });
      await db.upsertRepo({ installationId: 8, id: 80, fullName: 'other/app' });
      assert.equal((await db.repoByName('ACME/Web')).id, 70, 'names match without case');
      assert.deepEqual((await db.installationIds()).sort(), [7, 8]);

      // A real sync through the adapter, twice: the second changes nothing.
      const gh = fakeGitHub();
      gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1') }) });
      const ingest = ingester({ db, gh });
      await ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
      const first = await db.runs(7, 70);
      assert.deepEqual(first.map((r) => [r.runId, r.seq]), [['r1', 7]]);
      assert.equal(first[0].state.units[0].id, 'u1');
      assert.equal((await ingest.syncRepo(7, { id: 70, fullName: 'acme/web' })).unchanged, true);
      assert.equal((await db.runs(8, 70)).length, 0, 'another installation sees nothing');

      assert.equal(await db.seenDelivery('d1'), false);
      await db.recordDelivery('d1'); await db.recordDelivery('d1');
      assert.equal(await db.seenDelivery('d1'), true);

      const s = { idHash: 'h1', userId: 1, login: 'reader', tokenEnc: 'enc', refreshEnc: null, tokenExpiresAt: Date.now() + 1000, refreshExpiresAt: null, expiresAt: Date.now() + 60_000 };
      await db.putSession(s);
      assert.equal((await db.session('h1')).login, 'reader');
      await db.putSession({ ...s, idHash: 'old', expiresAt: Date.now() - 3_600_000 });
      assert.equal(await db.session('old'), null, 'an expired session is gone');
      await db.dropSession('h1');
      assert.equal(await db.session('h1'), null);

      // The trail's tables.
      await db.upsertRepo({ installationId: 7, id: 70, fullName: 'acme/web', private: true });
      await db.upsertRepo({ installationId: 7, id: 70, fullName: 'acme/web' });
      assert.equal((await db.repoByName('acme/web')).private, true, 'an unknown visibility keeps the known one');
      await db.setRepoSync(7, 70, { headSha: 'h', config: { trackers: false } });
      assert.deepEqual((await db.repoByName('acme/web')).config, { trackers: false });
      await db.setUnitRefs(7, 70, 'r1', [{ unit: 'u1', key: 'acme/web#12' }, { unit: 'u2', key: 'acme/web#12' }]);
      assert.deepEqual(await db.runsReferencing(7, 'acme/web#12'), [{ repoId: 70, runId: 'r1' }]);
      assert.deepEqual(await db.runsReferencing(8, 'acme/web#12'), [], 'scoped');
      await db.addGhEvent(7, { id: 'merged:acme/web#12', refKey: 'acme/web#12', kind: 'merged', at: '2026-11-06T11:00:00.000Z', detail: { label: 'PR' } });
      await db.addGhEvent(7, { id: 'merged:acme/web#12', refKey: 'acme/web#12', kind: 'merged', at: '2026-11-06T11:00:00.000Z', detail: { label: 'PR' } });
      assert.deepEqual(await db.ghEvents(7, ['acme/web#12']), [{ id: 'merged:acme/web#12', refKey: 'acme/web#12', kind: 'merged', at: '2026-11-06T11:00:00.000Z', detail: { label: 'PR' } }]);
      assert.deepEqual(await db.ghEvents(8, ['acme/web#12']), []);
      await db.putTracker(7, { refKey: 'acme/web#12', runId: 'r1', unitId: 'u1', commentId: 5, bodySha: 'b' });
      await db.putTracker(7, { refKey: 'acme/web#12', runId: 'r1', unitId: 'u1', boardSha: 'c' });
      assert.deepEqual(await db.tracker(7, 'acme/web#12', 'r1', 'u1'), { refKey: 'acme/web#12', runId: 'r1', unitId: 'u1', commentId: 5, bodySha: 'b', boardSha: 'c' });
      assert.equal(await db.tracker(8, 'acme/web#12', 'r1', 'u1'), null);
      await db.dropRunsExcept(7, 70, []);
      assert.deepEqual(await db.runsReferencing(7, 'acme/web#12'), [], 'refs go with their run');

      await db.audit('test', { installationId: 7, login: 'reader' });
      await db.deleteInstallation(7);
      assert.equal(await db.installation(7), null);
      assert.equal((await db.runs(7, 70)).length, 0, 'uninstall removes the rows');
      assert.equal((await db.repos(8)).length, 1, 'other installations stay');
    } finally { await db.close(); }
  });
}
