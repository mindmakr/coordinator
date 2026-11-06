// Postgres adapter: same contract as memory.mjs. Migrations in service/sql/
// run in order at start, once each, under an advisory lock.
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const SQL = new URL('../../sql/', import.meta.url);
const ms = (d) => (d ? new Date(d).getTime() : null);
const ts = (n) => (n === null || n === undefined ? null : new Date(n));
const iso = (d) => (d ? new Date(d).toISOString() : null);

export async function migrate(pool) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7471011)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(SQL).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(new URL(f, SQL), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(7471011)').catch(() => {});
    c.release();
  }
}

const repoRow = (r) => (r ? { installationId: Number(r.installation_id), id: Number(r.id), fullName: r.full_name, headSha: r.head_sha, syncedAt: iso(r.synced_at), error: r.sync_error, lessons: r.lessons } : null);
const runRow = (r) => (r ? { runId: r.run_id, eventsSha: r.events_sha, seq: r.seq, state: r.state, error: r.error, updatedAt: iso(r.updated_at) } : null);

export async function postgresDb(url, { max = 10 } = {}) {
  const pool = new pg.Pool({ connectionString: url, max });
  await migrate(pool);
  const q = (text, values) => pool.query(text, values);
  return {
    kind: 'postgres',
    pool,
    close: () => pool.end(),
    async seenDelivery(id) { return (await q('SELECT 1 FROM deliveries WHERE id = $1', [id])).rowCount > 0; },
    async recordDelivery(id) {
      await q('INSERT INTO deliveries (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      await q("DELETE FROM deliveries WHERE at < now() - interval '14 days'");
    },

    async upsertInstallation({ id, account }) {
      await q('INSERT INTO installations (id, account) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET account = $2, updated_at = now()', [id, account]);
    },
    async installation(id) { const r = (await q('SELECT id, account FROM installations WHERE id = $1', [id])).rows[0]; return r ? { id: Number(r.id), account: r.account } : null; },
    async installationIds() { return (await q('SELECT id FROM installations')).rows.map((r) => Number(r.id)); },
    async deleteInstallation(id) { await q('DELETE FROM installations WHERE id = $1', [id]); },

    async upsertRepo({ installationId, id, fullName }) {
      await q('INSERT INTO repos (installation_id, id, full_name) VALUES ($1, $2, $3) ON CONFLICT (installation_id, id) DO UPDATE SET full_name = $3', [installationId, id, fullName]);
    },
    async removeRepo(installationId, id) { await q('DELETE FROM repos WHERE installation_id = $1 AND id = $2', [installationId, id]); },
    async repos(installationId) { return (await q('SELECT * FROM repos WHERE installation_id = $1 ORDER BY full_name', [installationId])).rows.map(repoRow); },
    async repoByName(fullName) {
      return repoRow((await q('SELECT * FROM repos WHERE lower(full_name) = lower($1) ORDER BY synced_at DESC NULLS LAST LIMIT 1', [fullName])).rows[0]);
    },
    async setRepoSync(installationId, id, { headSha, error = null, lessons }) {
      if (lessons === undefined) await q('UPDATE repos SET head_sha = $3, sync_error = $4, synced_at = now() WHERE installation_id = $1 AND id = $2', [installationId, id, headSha, error]);
      else await q('UPDATE repos SET head_sha = $3, sync_error = $4, lessons = $5, synced_at = now() WHERE installation_id = $1 AND id = $2', [installationId, id, headSha, error, JSON.stringify(lessons)]);
    },

    async runs(installationId, repoId) { return (await q('SELECT * FROM runs WHERE installation_id = $1 AND repo_id = $2 ORDER BY run_id', [installationId, repoId])).rows.map(runRow); },
    async run(installationId, repoId, runId) { return runRow((await q('SELECT * FROM runs WHERE installation_id = $1 AND repo_id = $2 AND run_id = $3', [installationId, repoId, runId])).rows[0]); },
    async putRun(installationId, repoId, { runId, eventsSha, seq, state, error }) {
      await q(`INSERT INTO runs (installation_id, repo_id, run_id, events_sha, seq, state, error) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (installation_id, repo_id, run_id) DO UPDATE SET events_sha = $4, seq = $5, state = $6, error = $7, updated_at = now()`,
      [installationId, repoId, runId, eventsSha ?? null, seq ?? null, state === null || state === undefined ? null : JSON.stringify(state), error ?? null]);
    },
    async dropRunsExcept(installationId, repoId, keep) {
      await q('DELETE FROM runs WHERE installation_id = $1 AND repo_id = $2 AND NOT (run_id = ANY($3::text[]))', [installationId, repoId, keep]);
    },

    async putSession(s) {
      await q(`INSERT INTO sessions (id_hash, user_id, login, token_enc, refresh_enc, token_expires_at, refresh_expires_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.idHash, s.userId, s.login, s.tokenEnc, s.refreshEnc, ts(s.tokenExpiresAt), ts(s.refreshExpiresAt), ts(s.expiresAt)]);
      await q('DELETE FROM sessions WHERE expires_at < now()');
    },
    async session(idHash) {
      const r = (await q('SELECT * FROM sessions WHERE id_hash = $1 AND expires_at > now()', [idHash])).rows[0];
      return r ? { idHash: r.id_hash, userId: Number(r.user_id), login: r.login, tokenEnc: r.token_enc, refreshEnc: r.refresh_enc, tokenExpiresAt: ms(r.token_expires_at), refreshExpiresAt: ms(r.refresh_expires_at), expiresAt: ms(r.expires_at) } : null;
    },
    async updateSessionTokens(idHash, t) {
      await q('UPDATE sessions SET token_enc = $2, refresh_enc = $3, token_expires_at = $4, refresh_expires_at = $5 WHERE id_hash = $1', [idHash, t.tokenEnc, t.refreshEnc, ts(t.tokenExpiresAt), ts(t.refreshExpiresAt)]);
    },
    async dropSession(idHash) { await q('DELETE FROM sessions WHERE id_hash = $1', [idHash]); },

    async audit(kind, { installationId = null, login = null, detail = {} } = {}) {
      await q('INSERT INTO audit (kind, installation_id, login, detail) VALUES ($1, $2, $3, $4)', [kind, installationId, login, JSON.stringify(detail)]);
      await q("DELETE FROM audit WHERE at < now() - interval '90 days'");
    },
  };
}
