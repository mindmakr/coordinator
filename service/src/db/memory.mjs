// In-memory adapter: same contract as postgres.mjs. For tests and a quick
// local look; everything is gone on restart (the repo still has it all).
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const key = (...p) => p.join('\u0000');

export function memoryDb() {
  const deliveries = new Map(); const installations = new Map(); const repos = new Map(); const runs = new Map();
  const sessions = new Map(); const audit = [];
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
    },

    async upsertRepo({ installationId, id, fullName }) {
      const k = repoKey(installationId, id);
      repos.set(k, { headSha: null, syncedAt: null, error: null, lessons: null, ...repos.get(k), installationId, id, fullName });
    },
    async removeRepo(installationId, id) {
      repos.delete(repoKey(installationId, id));
      for (const [k, r] of runs) if (r.installationId === installationId && r.repoId === id) runs.delete(k);
    },
    async repos(installationId) { return [...repos.values()].filter((r) => r.installationId === installationId).map(clone); },
    async repoByName(fullName) {
      const hit = [...repos.values()].filter((r) => r.fullName.toLowerCase() === String(fullName).toLowerCase())
        .sort((a, b) => String(b.syncedAt ?? '').localeCompare(String(a.syncedAt ?? '')))[0];
      return clone(hit) ?? null;
    },
    async setRepoSync(installationId, id, { headSha, error = null, lessons }) {
      const r = repos.get(repoKey(installationId, id));
      if (!r) return;
      Object.assign(r, { headSha, error, syncedAt: new Date().toISOString() }, lessons !== undefined ? { lessons: clone(lessons) } : {});
    },

    async runs(installationId, repoId) {
      return [...runs.values()].filter((r) => r.installationId === installationId && r.repoId === repoId).sort((a, b) => a.runId.localeCompare(b.runId)).map(clone);
    },
    async run(installationId, repoId, runId) { return clone(runs.get(key(installationId, repoId, runId))) ?? null; },
    async putRun(installationId, repoId, row) {
      runs.set(key(installationId, repoId, row.runId), { ...clone(row), installationId, repoId, updatedAt: new Date().toISOString() });
    },
    async dropRunsExcept(installationId, repoId, keep) {
      const k = new Set(keep);
      for (const [x, r] of runs) if (r.installationId === installationId && r.repoId === repoId && !k.has(r.runId)) runs.delete(x);
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
