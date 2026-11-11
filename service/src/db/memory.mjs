// In-memory adapter: same contract as postgres.mjs. For tests and a quick
// local look; everything is gone on restart (the repo still has it all).
import { alertTables } from '../alerts/store.mjs';

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const key = (...p) => p.join('\u0000');

export function memoryDb() {
  const deliveries = new Map(); const installations = new Map(); const repos = new Map(); const runs = new Map();
  const uninstalled = new Set(); // c14: installation ids removed for good (GitHub never reuses one)
  const sessions = new Map(); const audit = [];
  const refs = new Map(); const ghEvents = new Map(); const trackers = new Map();
  const commands = new Map(); // c12 writes
  const alertRows = alertTables(); // c14: the alert store's tables (alerts/store.mjs)
  let trailCounter = 0; // trail_seq values, like Postgres's trail_seq_global
  const repoKey = (i, r) => key(i, r);
  return {
    kind: 'memory',
    alertTables: alertRows,
    async close() {},
    async seenDelivery(id) { return deliveries.has(id); },
    async recordDelivery(id) { deliveries.set(id, Date.now()); },

    // false (and nothing stored) for an id that was uninstalled: GitHub never reuses one, so a late event cannot bring it back.
    async upsertInstallation({ id, account }) { if (uninstalled.has(id)) return false; installations.set(id, { id, account }); return true; },
    async wasUninstalled(id) { return uninstalled.has(id); },
    async installation(id) { return clone(installations.get(id)) ?? null; },
    async installationIds() { return [...installations.keys()]; },
    async deleteInstallation(id) {
      uninstalled.add(id);
      installations.delete(id);
      for (const [k, r] of repos) if (r.installationId === id) repos.delete(k);
      for (const [k, r] of runs) if (r.installationId === id) runs.delete(k);
      for (const m of [refs, ghEvents, trackers, commands]) for (const [k, r] of m) if (r.installationId === id) m.delete(k);
      for (let i = audit.length - 1; i >= 0; i--) if (audit[i].installationId === id) audit.splice(i, 1);
    },

    async upsertRepo({ installationId, id, fullName, private: priv }) {
      const k = repoKey(installationId, id);
      const prev = repos.get(k);
      repos.set(k, { headSha: null, syncedAt: null, error: null, lessons: null, config: null, private: null, reread: false, ...prev, installationId, id, fullName, ...(priv === undefined ? {} : { private: priv }) });
    },
    async removeRepo(installationId, id) {
      repos.delete(repoKey(installationId, id));
      for (const [k, r] of runs) if (r.installationId === installationId && r.repoId === id) runs.delete(k);
      for (const [k, r] of refs) if (r.installationId === installationId && r.repoId === id) refs.delete(k);
      // c14: the repo's alerts, sent and queued for a digest, and who watched it.
      const { alerts, subs } = alertRows;
      for (let i = alerts.length - 1; i >= 0; i--) if (alerts[i].installationId === installationId && alerts[i].repoId === id) alerts.splice(i, 1);
      for (const [k, x] of subs) if (x.installationId === installationId && x.repoId === id) subs.delete(k);
    },
    async repos(installationId) { return [...repos.values()].filter((r) => r.installationId === installationId).map(clone); },
    async repoByName(installationId, fullName) {
      return clone([...repos.values()].find((r) => r.installationId === installationId && r.fullName.toLowerCase() === String(fullName).toLowerCase())) ?? null;
    },
    // id: GitHub's id for the repo; only a row with that id is returned (the newest synced, if several).
    async repoForPage(fullName, id) {
      const hit = [...repos.values()].filter((r) => r.fullName.toLowerCase() === String(fullName).toLowerCase() && r.id === Number(id))
        .sort((a, b) => String(b.syncedAt ?? '').localeCompare(String(a.syncedAt ?? '')))[0];
      return clone(hit) ?? null;
    },
    async setRepoSync(installationId, id, { headSha, error = null, lessons, config, reread }) {
      const r = repos.get(repoKey(installationId, id));
      if (!r) return;
      Object.assign(r, { headSha, error, syncedAt: new Date().toISOString() }, lessons !== undefined ? { lessons: clone(lessons) } : {}, config !== undefined ? { config: clone(config) } : {}, reread !== undefined ? { reread } : {});
    },
    // c14: a forced re-read starts (unless one is unfinished): the runs' blob shas are forgotten, so each is read again.
    async startReread(installationId, id) {
      const r = repos.get(repoKey(installationId, id));
      if (!r || r.reread) return;
      r.reread = true;
      for (const x of runs.values()) if (x.installationId === installationId && x.repoId === id) Object.assign(x, { eventsSha: null, mapSha: null });
    },

    async runs(installationId, repoId) {
      return [...runs.values()].filter((r) => r.installationId === installationId && r.repoId === repoId).sort((a, b) => a.runId.localeCompare(b.runId)).map(clone);
    },
    // The same rows as runs(), in the same order, without the heavy columns: never the map, and the state only
    // when asked (state: true). open: true keeps only the runs that have a state and are not closed.
    // finished: false leaves out the finished runs (open and unreadable ones stay).
    async runSummaries(installationId, repoId, { state = false, open = false, finished = true } = {}) {
      return [...runs.values()].filter((r) => r.installationId === installationId && r.repoId === repoId && (!open || (r.state && !r.state.closed)) && (finished || !(r.state && r.state.closed)))
        .sort((a, b) => a.runId.localeCompare(b.runId)).map(({ state: s, map: _, ...rest }) => clone(state ? { ...rest, state: s } : rest));
    },
    // One page of a repo's finished runs with their state, the most recently changed first, and how many there are in all.
    async finishedRuns(installationId, repoId, { limit = 30, offset = 0 } = {}) {
      const all = [...runs.values()].filter((r) => r.installationId === installationId && r.repoId === repoId && r.state && r.state.closed)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.runId.localeCompare(a.runId));
      return { total: all.length, rows: all.slice(offset, offset + limit).map(({ map: _, ...rest }) => clone(rest)) };
    },
    // map: false leaves the project map unread; the row then has map: null.
    async run(installationId, repoId, runId, { map = true } = {}) {
      const r = runs.get(key(installationId, repoId, runId));
      return r ? clone(map ? r : { ...r, map: null }) : null;
    },
    async putRun(installationId, repoId, row) {
      const prev = runs.get(key(installationId, repoId, row.runId));
      runs.set(key(installationId, repoId, row.runId), { mapSha: null, map: null, mapError: null, trailPending: false, trailSeq: 0, ...(prev && { mapSha: prev.mapSha, map: prev.map, mapError: prev.mapError, trailPending: prev.trailPending, trailSeq: prev.trailSeq }), ...clone(row), installationId, repoId, updatedAt: new Date().toISOString() });
    },
    async putRunMap(installationId, repoId, runId, { mapSha, map, mapError }) {
      const r = runs.get(key(installationId, repoId, runId));
      if (r) Object.assign(r, { mapSha, map: clone(map), mapError });
    },
    async markTrailPending(installationId, repoId, runId) {
      const r = runs.get(key(installationId, repoId, runId));
      if (!r) return null;
      Object.assign(r, { trailPending: true, trailSeq: ++trailCounter }); // one counter for every run: a re-created run never reuses a value
      return r.trailSeq;
    },
    async clearTrailPending(installationId, repoId, runId, seq) {
      const r = runs.get(key(installationId, repoId, runId));
      if (!r || r.trailSeq !== seq) return false;
      r.trailPending = false;
      return true;
    },
    async dropRunsExcept(installationId, repoId, keep) {
      const k = new Set(keep);
      for (const [x, r] of runs) if (r.installationId === installationId && r.repoId === repoId && !k.has(r.runId)) runs.delete(x);
      for (const [x, r] of refs) if (r.installationId === installationId && r.repoId === repoId && !k.has(r.runId)) refs.delete(x);
    },

    async setUnitRefs(installationId, repoId, runId, list) {
      for (const [x, r] of refs) if (r.installationId === installationId && r.repoId === repoId && r.runId === runId) refs.delete(x);
      for (const { unit, key: refKey } of list) refs.set(key(installationId, repoId, runId, unit, refKey), { installationId, repoId, runId, unitId: unit, refKey });
    },
    async runsReferencing(installationId, refKey) {
      const out = new Map();
      for (const r of refs.values()) if (r.installationId === installationId && r.refKey === refKey) out.set(key(r.repoId, r.runId), { repoId: r.repoId, runId: r.runId });
      return [...out.values()];
    },
    async addGhEvent(installationId, e) { ghEvents.set(key(installationId, e.id), { ...clone(e), installationId }); },
    async ghEvents(installationId, refKeys) {
      const k = new Set(refKeys);
      return [...ghEvents.values()].filter((e) => e.installationId === installationId && k.has(e.refKey)).sort((a, b) => a.at.localeCompare(b.at)).map(({ installationId: _, ...e }) => clone(e));
    },
    async tracker(installationId, refKey, runId, unitId) {
      const t = trackers.get(key(installationId, refKey, runId, unitId));
      if (!t) return null;
      const { installationId: _, ...rest } = t;
      return clone(rest);
    },
    async putTracker(installationId, t) {
      const k = key(installationId, t.refKey, t.runId, t.unitId);
      trackers.set(k, { commentId: null, bodySha: null, boardSha: null, ...trackers.get(k), ...clone(t), installationId });
    },

    // c12 writes: true when this call claimed the comment (it was not handled before).
    async claimCommand(installationId, commentId) { const k = key(installationId, commentId); if (commands.has(k)) return false; commands.set(k, { installationId, status: 'claimed' }); return true; },
    async finishCommand(installationId, commentId, status) { const c = commands.get(key(installationId, commentId)); if (c) c.status = status; },
    async releaseCommand(installationId, commentId) { commands.delete(key(installationId, commentId)); },

    async putSession(s) { sessions.set(s.idHash, clone(s)); },
    async session(idHash) {
      const s = sessions.get(idHash);
      if (s && s.expiresAt <= Date.now()) { sessions.delete(idHash); return null; }
      return clone(s) ?? null;
    },
    async updateSessionTokens(idHash, t) { const s = sessions.get(idHash); if (s) Object.assign(s, clone(t)); },
    async dropSession(idHash) { sessions.delete(idHash); },

    async audit(kind, { installationId = null, login = null, detail = {} } = {}) { audit.push({ at: new Date().toISOString(), kind, installationId, login, detail: clone(detail) }); },
    auditLog: () => audit.map(clone),
  };
}
