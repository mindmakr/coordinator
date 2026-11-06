// Migrations apply in order on a fresh database and on one already at 005 (Postgres only).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/db/postgres.mjs';

const PG = process.env.TEST_DATABASE_URL;
const SQL = new URL('../sql/', import.meta.url);
const files = readdirSync(SQL).filter((f) => f.endsWith('.sql')).sort();

async function inSchema(name, fn) {
  const admin = new pg.Client({ connectionString: PG }); await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await admin.query(`CREATE SCHEMA ${name}`);
  const pool = new pg.Pool({ connectionString: PG, max: 2, options: `-c search_path=${name}` });
  try { await fn(pool); } finally { await pool.end(); await admin.query(`DROP SCHEMA ${name} CASCADE`); await admin.end(); }
}
const applied = async (pool) => (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);

test('migrations: a fresh database gets every one, in order, once', { skip: !PG && 'set TEST_DATABASE_URL to run against Postgres' }, async () => {
  await inSchema(`m_fresh_${process.pid}`, async (pool) => {
    await migrate(pool); await migrate(pool);
    assert.deepEqual(await applied(pool), files);
    assert.equal(Number((await pool.query("SELECT nextval('trail_seq_global') AS n")).rows[0].n), 1);
  });
});

test('migrations: a database at 005 with trail_seq values gets 006 and 007, and the global sequence starts above them', { skip: !PG && 'set TEST_DATABASE_URL to run against Postgres' }, async () => {
  await inSchema(`m_005_${process.pid}`, async (pool) => {
    await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
    for (const f of files.filter((x) => x < '006')) {
      await pool.query(readFileSync(new URL(f, SQL), 'utf8'));
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    }
    await pool.query("INSERT INTO installations (id, account) VALUES (7, 'acme')");
    await pool.query("INSERT INTO repos (installation_id, id, full_name) VALUES (7, 70, 'acme/web')");
    await pool.query("INSERT INTO runs (installation_id, repo_id, run_id, events_sha, seq, state, trail_seq) VALUES (7, 70, 'r1', 'x', 1, '{}', 41), (7, 70, 'r2', 'y', 1, '{}', 9)");
    await migrate(pool);
    assert.deepEqual(await applied(pool), files);
    assert.ok(Number((await pool.query("SELECT nextval('trail_seq_global') AS n")).rows[0].n) > 41, 'never at or below a value a refresh may hold');
  });
});
