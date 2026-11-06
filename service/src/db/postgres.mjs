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

const repoRow = (r) => (r ? { installationId: Number(r.installation_id), id: Number(r.id), fullName: r.full_name, headSha: r.head_sha, syncedAt: iso(r.synced_at), error: r.sync_error, lessons: r.lessons, config: r.config ?? null, private: r.private ?? null } : null);
const runRow = (r) => (r ? { runId: r.run_id, eventsSha: r.events_sha, seq: r.seq, state: r.state, error: r.error, updatedAt: iso(r.updated_at), mapSha: r.map_sha ?? null, map: r.map ?? null, mapError: r.map_error ?? null, trailPending: r.trail_pending === true, trailSeq: Number(r.trail_seq ?? 0) } : null);

// schema (tests): a throwaway schema of its own, dropped on close.
export async function postgresDb(url, { max = 10, schema = null } = {}) {
  if (schema !== null && !/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error('bad schema name');
  if (schema) { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); await c.end(); }
  const pool = new pg.Pool({ connectionString: url, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  await migrate(pool);
  const q = (text, values) => pool.query(text, values);
  return {
    kind: 'postgres',
    pool,
    async close() {
      if (schema) await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
      await pool.end();
    },
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

    async upsertRepo({ installationId, id, fullName, private: priv }) {
      await q(`INSERT INTO repos (installation_id, id, full_name, private) VALUES ($1, $2, $3, $4)
        ON CONFLICT (installation_id, id) DO UPDATE SET full_name = $3, private = COALESCE($4, repos.private)`, [installationId, id, fullName, priv ?? null]);
    },
    async removeRepo(installationId, id) { await q('DELETE FROM repos WHERE installation_id = $1 AND id = $2', [installationId, id]); },
    async repos(installationId) { return (await q('SELECT * FROM repos WHERE installation_id = $1 ORDER BY full_name', [installationId])).rows.map(repoRow); },
    async repoByName(installationId, fullName) {
      return repoRow((await q('SELECT * FROM repos WHERE installation_id = $1 AND lower(full_name) = lower($2) ORDER BY synced_at DESC NULLS LAST LIMIT 1', [installationId, fullName])).rows[0]);
    },
    async repoForPage(fullName) {
      return repoRow((await q('SELECT * FROM repos WHERE lower(full_name) = lower($1) ORDER BY synced_at DESC NULLS LAST LIMIT 1', [fullName])).rows[0]);
    },
    async setRepoSync(installationId, id, { headSha, error = null, lessons, config }) {
      const set = ['head_sha = $3', 'sync_error = $4', 'synced_at = now()']; const v = [installationId, id, headSha, error];
      if (lessons !== undefined) { v.push(JSON.stringify(lessons)); set.push(`lessons = $${v.length}`); }
      if (config !== undefined) { v.push(JSON.stringify(config)); set.push(`config = $${v.length}`); }
      await q(`UPDATE repos SET ${set.join(', ')} WHERE installation_id = $1 AND id = $2`, v);
    },

    async runs(installationId, repoId) { return (await q('SELECT * FROM runs WHERE installation_id = $1 AND repo_id = $2 ORDER BY run_id', [installationId, repoId])).rows.map(runRow); },
    async run(installationId, repoId, runId) { return runRow((await q('SELECT * FROM runs WHERE installation_id = $1 AND repo_id = $2 AND run_id = $3', [installationId, repoId, runId])).rows[0]); },
    async putRun(installationId, repoId, { runId, eventsSha, seq, state, error }) {
      await q(`INSERT INTO runs (installation_id, repo_id, run_id, events_sha, seq, state, error) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (installation_id, repo_id, run_id) DO UPDATE SET events_sha = $4, seq = $5, state = $6, error = $7, updated_at = now()`,
      [installationId, repoId, runId, eventsSha ?? null, seq ?? null, state === null || state === undefined ? null : JSON.stringify(state), error ?? null]);
    },
    async putRunMap(installationId, repoId, runId, { mapSha, map, mapError }) {
      await q('UPDATE runs SET map_sha = $4, map = $5, map_error = $6 WHERE installation_id = $1 AND repo_id = $2 AND run_id = $3',
        [installationId, repoId, runId, mapSha ?? null, map === null || map === undefined ? null : JSON.stringify(map), mapError ?? null]);
    },
    async markTrailPending(installationId, repoId, runId) {
      await q('UPDATE runs SET trail_pending = true, trail_seq = trail_seq + 1 WHERE installation_id = $1 AND repo_id = $2 AND run_id = $3', [installationId, repoId, runId]);
    },
    async clearTrailPending(installationId, repoId, runId, seq) {
      return (await q('UPDATE runs SET trail_pending = false WHERE installation_id = $1 AND repo_id = $2 AND run_id = $3 AND trail_seq = $4', [installationId, repoId, runId, seq])).rowCount > 0;
    },
    async dropRunsExcept(installationId, repoId, keep) {
      await q('DELETE FROM runs WHERE installation_id = $1 AND repo_id = $2 AND NOT (run_id = ANY($3::text[]))', [installationId, repoId, keep]);
      await q('DELETE FROM unit_refs WHERE installation_id = $1 AND repo_id = $2 AND NOT (run_id = ANY($3::text[]))', [installationId, repoId, keep]);
    },

    async setUnitRefs(installationId, repoId, runId, list) {
      await q('DELETE FROM unit_refs WHERE installation_id = $1 AND repo_id = $2 AND run_id = $3', [installationId, repoId, runId]);
      for (const { unit, key } of list) {
        await q('INSERT INTO unit_refs (installation_id, repo_id, run_id, unit_id, ref_key) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [installationId, repoId, runId, unit, key]);
      }
    },
    async runsReferencing(installationId, refKey) {
      return (await q('SELECT DISTINCT repo_id, run_id FROM unit_refs WHERE installation_id = $1 AND ref_key = $2', [installationId, refKey])).rows.map((r) => ({ repoId: Number(r.repo_id), runId: r.run_id }));
    },
    async addGhEvent(installationId, e) {
      await q(`INSERT INTO gh_events (installation_id, id, ref_key, kind, at, detail) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (installation_id, id) DO UPDATE SET kind = $4, at = $5, detail = $6`, [installationId, e.id, e.refKey, e.kind, e.at, JSON.stringify(e.detail ?? {})]);
      await q("DELETE FROM gh_events WHERE at < now() - interval '180 days'");
    },
    async ghEvents(installationId, refKeys) {
      return (await q('SELECT * FROM gh_events WHERE installation_id = $1 AND ref_key = ANY($2::text[]) ORDER BY at', [installationId, refKeys])).rows
        .map((r) => ({ id: r.id, refKey: r.ref_key, kind: r.kind, at: iso(r.at), detail: r.detail }));
    },
    async tracker(installationId, refKey, runId, unitId) {
      const r = (await q('SELECT * FROM trackers WHERE installation_id = $1 AND ref_key = $2 AND run_id = $3 AND unit_id = $4', [installationId, refKey, runId, unitId])).rows[0];
      return r ? { refKey: r.ref_key, runId: r.run_id, unitId: r.unit_id, commentId: r.comment_id === null ? null : Number(r.comment_id), bodySha: r.body_sha, boardSha: r.board_sha } : null;
    },
    async putTracker(installationId, t) {
      const cur = (await q('SELECT comment_id, body_sha, board_sha FROM trackers WHERE installation_id = $1 AND ref_key = $2 AND run_id = $3 AND unit_id = $4', [installationId, t.refKey, t.runId, t.unitId])).rows[0];
      const n = { commentId: cur?.comment_id ?? null, bodySha: cur?.body_sha ?? null, boardSha: cur?.board_sha ?? null, ...t };
      await q(`INSERT INTO trackers (installation_id, ref_key, run_id, unit_id, comment_id, body_sha, board_sha) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (installation_id, ref_key, run_id, unit_id) DO UPDATE SET comment_id = $5, body_sha = $6, board_sha = $7`,
      [installationId, n.refKey, n.runId, n.unitId, n.commentId, n.bodySha, n.boardSha]);
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
