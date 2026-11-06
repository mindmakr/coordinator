// Where alerts keep their rows: settings, subscriptions, push endpoints and the
// alert log. One contract, two adapters, chosen by the read model's kind: the
// Postgres one shares db.pool (tables from sql/006_alerts.sql), the memory one
// keeps Maps for tests and quick local runs.
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function alertStore(db) {
  return db.kind === 'postgres' ? pgStore(db.pool) : memoryStore();
}

function memoryStore() {
  const settings = new Map(); const subs = new Map(); const push = new Map(); const alerts = [];
  let nextId = 1;
  const subKey = (u, i, r) => `${u}:${i}:${r}`;
  return {
    async settings(userId) { return clone(settings.get(userId)?.settings) ?? null; },
    async loginOf(userId) { return settings.get(userId)?.login ?? [...subs.values()].find((s) => s.userId === userId)?.login ?? null; },
    async putSettings(userId, login, s) { settings.set(userId, { login, settings: clone(s) }); },
    async userByEmailToken(hash) {
      for (const [userId, row] of settings) if (row.settings.emailTokenHash === hash) return { userId, login: row.login, settings: clone(row.settings) };
      return null;
    },
    async subscribe(userId, login, installationId, repoId, at) { subs.set(subKey(userId, installationId, repoId), { userId, login, installationId, repoId, checkedAt: at }); },
    async unsubscribe(userId, installationId, repoId) { subs.delete(subKey(userId, installationId, repoId)); },
    async subscriptions(userId) { return [...subs.values()].filter((s) => s.userId === userId).map(clone); },
    async subscribers(installationId, repoId) { return [...subs.values()].filter((s) => s.installationId === installationId && s.repoId === repoId).map(clone); },
    // false when the endpoint is another person's: a device is never moved from one person to another.
    async addPush(userId, sub) {
      const prev = push.get(sub.endpoint);
      if (prev && prev.userId !== userId) return false;
      push.set(sub.endpoint, { userId, endpoint: sub.endpoint, keys: clone(sub.keys) });
      return true;
    },
    async pushSubs(userId) { return [...push.values()].filter((p) => p.userId === userId).map(({ endpoint, keys }) => ({ endpoint, keys: clone(keys) })); },
    async dropPush(endpoint) { push.delete(endpoint); },
    async recent(userId, collapseKey, sinceMs) {
      return clone(alerts.filter((a) => a.userId === userId && a.collapseKey === collapseKey && a.createdAt >= sinceMs).at(-1)) ?? null;
    },
    async bump(id) { const a = alerts.find((x) => x.id === id); if (a) a.count += 1; },
    async addAlert(a) { const row = { id: nextId++, count: 1, sentAt: null, ...clone(a) }; alerts.push(row); return row.id; },
    async alertsFor(userId, limit = 50) { return alerts.filter((a) => a.userId === userId).slice(-limit).reverse().map(clone); },
    async queuedUsers() { return [...new Set(alerts.filter((a) => a.status === 'queued').map((a) => a.userId))]; },
    async queued(userId) { return alerts.filter((a) => a.userId === userId && a.status === 'queued').map(clone); },
    async markSent(ids, at) { for (const a of alerts) if (ids.includes(a.id)) Object.assign(a, { status: 'sent', sentAt: at }); },
    async setStatus(id, status, detail, at) { const a = alerts.find((x) => x.id === id); if (a) Object.assign(a, { status, detail: clone(detail), sentAt: at }); },
    async deleteInstallation(installationId) {
      for (const [k, s] of subs) if (s.installationId === installationId) subs.delete(k);
      for (let i = alerts.length - 1; i >= 0; i--) if (alerts[i].installationId === installationId) alerts.splice(i, 1);
    },
    rows: (installationId) => ({ alerts: alerts.filter((a) => a.installationId === installationId).length, subscriptions: [...subs.values()].filter((s) => s.installationId === installationId).length }), // tests
  };
}

const ms = (d) => (d ? new Date(d).getTime() : null);
const alertRow = (r) => ({
  id: Number(r.id), userId: Number(r.user_id), installationId: Number(r.installation_id), repoId: Number(r.repo_id), runId: r.run_id, unitId: r.unit_id,
  trigger: r.trigger, urgency: r.urgency, collapseKey: r.collapse_key, status: r.status, count: r.count, detail: r.detail, createdAt: ms(r.created_at), sentAt: ms(r.sent_at),
});
const subRow = (r) => ({ userId: Number(r.user_id), login: r.login, installationId: Number(r.installation_id), repoId: Number(r.repo_id), checkedAt: ms(r.checked_at) });

function pgStore(pool) {
  const q = (text, values) => pool.query(text, values);
  return {
    async settings(userId) { return (await q('SELECT settings FROM alert_settings WHERE user_id = $1', [userId])).rows[0]?.settings ?? null; },
    async loginOf(userId) {
      return (await q('SELECT login FROM alert_settings WHERE user_id = $1 UNION ALL SELECT login FROM alert_subscriptions WHERE user_id = $1 LIMIT 1', [userId])).rows[0]?.login ?? null;
    },
    async putSettings(userId, login, s) {
      await q(`INSERT INTO alert_settings (user_id, login, settings) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET login = $2, settings = $3, updated_at = now()`, [userId, login, JSON.stringify(s)]);
    },
    async userByEmailToken(hash) {
      const r = (await q("SELECT user_id, login, settings FROM alert_settings WHERE settings->>'emailTokenHash' = $1", [hash])).rows[0];
      return r ? { userId: Number(r.user_id), login: r.login, settings: r.settings } : null;
    },
    async subscribe(userId, login, installationId, repoId, at) {
      await q(`INSERT INTO alert_subscriptions (user_id, login, installation_id, repo_id, checked_at) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, installation_id, repo_id) DO UPDATE SET login = $2, checked_at = $5`, [userId, login, installationId, repoId, new Date(at)]);
    },
    async unsubscribe(userId, installationId, repoId) { await q('DELETE FROM alert_subscriptions WHERE user_id = $1 AND installation_id = $2 AND repo_id = $3', [userId, installationId, repoId]); },
    async subscriptions(userId) { return (await q('SELECT * FROM alert_subscriptions WHERE user_id = $1', [userId])).rows.map(subRow); },
    async subscribers(installationId, repoId) { return (await q('SELECT * FROM alert_subscriptions WHERE installation_id = $1 AND repo_id = $2', [installationId, repoId])).rows.map(subRow); },
    // false when the endpoint is another person's: a device is never moved from one person to another.
    async addPush(userId, sub) {
      return (await q(`INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES ($1, $2, $3)
        ON CONFLICT (endpoint) DO UPDATE SET keys = $3 WHERE push_subscriptions.user_id = $2`, [sub.endpoint, userId, JSON.stringify(sub.keys)])).rowCount === 1;
    },
    async pushSubs(userId) { return (await q('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1', [userId])).rows.map((r) => ({ endpoint: r.endpoint, keys: r.keys })); },
    async dropPush(endpoint) { await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]); },
    async recent(userId, collapseKey, sinceMs) {
      const r = (await q('SELECT * FROM alerts WHERE user_id = $1 AND collapse_key = $2 AND created_at >= $3 ORDER BY created_at DESC, id DESC LIMIT 1', [userId, collapseKey, new Date(sinceMs)])).rows[0];
      return r ? alertRow(r) : null;
    },
    async bump(id) { await q('UPDATE alerts SET count = count + 1 WHERE id = $1', [id]); },
    async addAlert(a) {
      const r = await q(`INSERT INTO alerts (user_id, installation_id, repo_id, run_id, unit_id, trigger, urgency, collapse_key, status, detail, created_at, sent_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [a.userId, a.installationId, a.repoId, a.runId, a.unitId ?? null, a.trigger, a.urgency, a.collapseKey, a.status, JSON.stringify(a.detail ?? {}), new Date(a.createdAt), a.sentAt ? new Date(a.sentAt) : null]);
      await q("DELETE FROM alerts WHERE created_at < now() - interval '90 days'");
      return Number(r.rows[0].id);
    },
    async alertsFor(userId, limit = 50) { return (await q('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, limit])).rows.map(alertRow); },
    async queuedUsers() { return (await q("SELECT DISTINCT user_id FROM alerts WHERE status = 'queued'")).rows.map((r) => Number(r.user_id)); },
    async queued(userId) { return (await q("SELECT * FROM alerts WHERE user_id = $1 AND status = 'queued' ORDER BY created_at, id", [userId])).rows.map(alertRow); },
    async markSent(ids, at) { await q("UPDATE alerts SET status = 'sent', sent_at = $2 WHERE id = ANY($1::bigint[])", [ids, new Date(at)]); },
    async setStatus(id, status, detail, at) { await q('UPDATE alerts SET status = $2, detail = $3, sent_at = $4 WHERE id = $1', [id, status, JSON.stringify(detail ?? {}), at ? new Date(at) : null]); },
    // Sent and queued (digest) alerts; subscriptions also cascade with the repos.
    async deleteInstallation(installationId) {
      await q('DELETE FROM alerts WHERE installation_id = $1', [installationId]);
      await q('DELETE FROM alert_subscriptions WHERE installation_id = $1', [installationId]);
    },
  };
}
