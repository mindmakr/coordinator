// In-memory adapter: same contract as postgres.mjs. For tests and a quick
// local look; everything is gone on restart (the repo still has it all).
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const key = (...p) => p.join('\u0000');

export function memoryDb() {
  const deliveries = new Map(); const installations = new Map(); const repos = new Map(); const runs = new Map();
  const sessions = new Map(); const audit = [];
  const refs = new Map(); const ghEvents = new Map(); const trackers = new Map();
  const repoKey = (i, r) => key(i, r);
  return {
    kind: 'memory',
    async close() {},
    async seenDelivery(id) { return deliveries.has(id); },
    async recordDelivery(id) { deliveries.set(id, Date.now()); },

    async upsertInstallation({ id, account }) { installations.set(id, { id, account }); },
    async installation(id) { return clone(installations.get(id)) ?? null; },
    async installationIds() { return [...installations.keys()]; },
    async deleteInstallation(id) {
      installations.delete(id);
      for (const [k, r] of repos) if (r.installationId === id) repos.delete(k);
      for (const [k, r] of runs) if (r.installationId === id) runs.delete(k);
      for (const m of [refs, ghEvents, trackers]) for (const [k, r] of m) if (r.installationId === id) m.delete(k);
    },

    async upsertRepo({ installationId, id, fullName, private: priv }) {
      const k = repoKey(installationId, id);
      const prev = repos.get(k);
      repos.set(k, { headSha: null, syncedAt: null, error: null, lessons: null, config: null, private: null, ...prev, installationId, id, fullName, ...(priv === undefined ? {} : { private: priv }) });
    },
    async removeRepo(installationId, id) {
      repos.delete(repoKey(installationId, id));
      for (const [k, r] of runs) if (r.installationId === installationId && r.repoId === id) runs.delete(k);
      for (const [k, r] of refs) if (r.installationId === installationId && r.repoId === id) refs.delete(k);
    },
    async repos(installationId) { return [...repos.values()].filter((r) => r.installationId === installationId).map(clone); },
    async repoByName(fullName) {
      const hit = [...repos.values()].filter((r) => r.fullName.toLowerCase() === String(fullName).toLowerCase())
        .sort((a, b) => String(b.syncedAt ?? '').localeCompare(String(a.syncedAt ?? '')))[0];
      return clone(hit) ?? null;
    },
    async setRepoSync(installationId, id, { headSha, error = null, lessons, config }) {
      const r = repos.get(repoKey(installationId, id));
      if (!r) return;
      Object.assign(r, { headSha, error, syncedAt: new Date().toISOString() }, lessons !== undefined ? { lessons: clone(lessons) } : {}, config !== undefined ? { config: clone(config) } : {});
    },

    async runs(installationId, repoId) {
      return [...runs.values()].filter((r) => r.installationId === installationId && r.repoId === repoId).sort((a, b) => a.runId.localeCompare(b.runId)).map(clone);
    },
    async run(installationId, repoId, runId) { return clone(runs.get(key(installationId, repoId, runId))) ?? null; },
    async putRun(installationId, repoId, row) {
      const prev = runs.get(key(installationId, repoId, row.runId));
      runs.set(key(installationId, repoId, row.runId), { mapSha: null, map: null, mapError: null, trailPending: false, ...(prev && { mapSha: prev.mapSha, map: prev.map, mapError: prev.mapError, trailPending: prev.trailPending }), ...clone(row), installationId, repoId, updatedAt: new Date().toISOString() });
    },
    async putRunMap(installationId, repoId, runId, { mapSha, map, mapError }) {
      const r = runs.get(key(installationId, repoId, runId));
      if (r) Object.assign(r, { mapSha, map: clone(map), mapError });
    },
    async setTrailPending(installationId, repoId, runId, pending) {
      const r = runs.get(key(installationId, repoId, runId));
      if (r) r.trailPending = !!pending;
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
