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
  await c.query('DROP TABLE IF EXISTS audit, sessions, deliveries, runs, repos, installations, schema_migrations CASCADE');
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
      await db.putSession({ ...s, idHash: 'old', expiresAt: Date.now() - 1 });
      assert.equal(await db.session('old'), null, 'an expired session is gone');
      await db.dropSession('h1');
      assert.equal(await db.session('h1'), null);

      await db.audit('test', { installationId: 7, login: 'reader' });
      await db.deleteInstallation(7);
      assert.equal(await db.installation(7), null);
      assert.equal((await db.runs(7, 70)).length, 0, 'uninstall removes the rows');
      assert.equal((await db.repos(8)).length, 1, 'other installations stay');
    } finally { await db.close(); }
  });
}
