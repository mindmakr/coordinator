// Reads a repo's coordinator-state branch into the read model. The event log is
// the run: each runs/<run>/events.jsonl is parsed and validated with the
// skill's own schema (core.mjs), replayed into state, masked again, and stored.
// Idempotent: the branch tip and each log's blob sha are compared first, so a
// redelivered webhook or a repeated sync changes nothing. A log that fails
// validation keeps the last good state and records why; other runs go on.
import { isSafeId, maskSecrets, parseLog, replay, validRun } from './core.mjs';

const RUN_LOG = /^runs\/([^/]+)\/events\.jsonl$/;
const MARKER = '.coordinator-state';
export const LIMITS = { logBytes: 8 * 1024 * 1024, runs: 500, lessonsBytes: 1024 * 1024 };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const maskDeep = (v) => (typeof v === 'string' ? maskSecrets(v) : Array.isArray(v) ? v.map(maskDeep) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])) : v);

// The run a log describes, or an error message. Never throws.
export function readLog(runId, buf) {
  try {
    const log = parseLog(buf, `runs/${runId}/events.jsonl`);
    if (!log.events.length) return { error: 'the event log is empty' };
    const state = replay(log.events);
    const err = validRun(state);
    if (err) return { error: `the replayed state is not a run: ${err}` };
    if (state.id !== runId) return { error: `the log describes run ${JSON.stringify(String(state.id).slice(0, 64))}, not ${runId}` };
    return { state: maskDeep(state), seq: log.events.length };
  } catch (e) { return { error: maskSecrets(String(e.message)).slice(0, 500) }; }
}

export function ingester({ db, gh, branch = 'coordinator-state', log }) {
  const chains = new Map(); // one sync per repo at a time; a second waits for the first
  const serial = (k, fn) => {
    const next = (chains.get(k) ?? Promise.resolve()).catch(() => {}).then(fn);
    chains.set(k, next);
    next.finally(() => { if (chains.get(k) === next) chains.delete(k); }).catch(() => {});
    return next;
  };

  async function syncRepo(installationId, repo, { force = false, token = null } = {}) {
    return serial(`${installationId}:${repo.id}`, async () => {
      token ??= await gh.installationToken(installationId);
      const current = (await db.repos(installationId)).find((r) => r.id === repo.id);
      const head = await gh.ref(token, repo.fullName, branch);
      if (!head) {
        await db.dropRunsExcept(installationId, repo.id, []);
        await db.setRepoSync(installationId, repo.id, { headSha: null, error: null, lessons: null });
        return { repo: repo.fullName, head: null, runs: 0 };
      }
      if (!force && current?.headSha === head) return { repo: repo.fullName, head, unchanged: true };
      const tree = await gh.tree(token, repo.fullName, head);
      const entries = tree.tree ?? [];
      if (!entries.some((e) => e.path === MARKER && e.type === 'blob')) {
        await db.setRepoSync(installationId, repo.id, { headSha: head, error: `${branch} holds no coordinator state (no ${MARKER} marker)` });
        return { repo: repo.fullName, head, error: 'no marker' };
      }
      const logs = entries.filter((e) => e.type === 'blob' && RUN_LOG.test(e.path)).map((e) => ({ ...e, runId: RUN_LOG.exec(e.path)[1] }))
        .filter((e) => isSafeId(e.runId)).slice(0, LIMITS.runs);
      const have = new Map((await db.runs(installationId, repo.id)).map((r) => [r.runId, r]));
      const out = { repo: repo.fullName, head, runs: logs.length, updated: [], failed: [] };
      for (const e of logs) {
        const prev = have.get(e.runId);
        if (prev?.eventsSha === e.sha && !force) continue; // same bytes, same result
        const r = e.size > LIMITS.logBytes ? { error: `the event log is larger than ${LIMITS.logBytes} bytes` } : readLog(e.runId, await gh.blob(token, repo.fullName, e.sha));
        if (r.error) {
          // Keep the last good state; record the failure against this blob.
          await db.putRun(installationId, repo.id, { runId: e.runId, eventsSha: e.sha, seq: prev?.seq ?? null, state: prev?.state ?? null, error: r.error });
          out.failed.push(e.runId);
          log?.warn('run log rejected', { repo: repo.fullName, run: e.runId, reason: r.error });
        } else {
          await db.putRun(installationId, repo.id, { runId: e.runId, eventsSha: e.sha, seq: r.seq, state: r.state, error: null });
          out.updated.push(e.runId);
        }
      }
      await db.dropRunsExcept(installationId, repo.id, logs.map((e) => e.runId));
      const lessons = await readLessons(token, repo, entries);
      await db.setRepoSync(installationId, repo.id, { headSha: head, error: tree.truncated ? 'the branch tree was too large to read whole; some runs may be missing' : null, lessons });
      return out;
    });
  }

  async function readLessons(token, repo, entries) {
    const e = entries.find((x) => x.path === 'lessons/lessons.json' && x.type === 'blob');
    if (!e || e.size > LIMITS.lessonsBytes) return null;
    try {
      const j = JSON.parse((await gh.blob(token, repo.fullName, e.sha)).toString('utf8'));
      return Array.isArray(j) ? maskDeep(j.filter(isObj)) : null;
    } catch { return null; }
  }

  // Every repo the installation can reach now: new ones added, gone ones removed, each synced.
  async function syncInstallation(installationId, { force = false } = {}) {
    const token = await gh.installationToken(installationId);
    const seen = [];
    for await (const r of gh.installationRepos(token)) seen.push({ id: r.id, fullName: r.full_name });
    const known = await db.repos(installationId);
    for (const r of known) if (!seen.some((s) => s.id === r.id)) await db.removeRepo(installationId, r.id);
    const results = [];
    for (const r of seen) {
      await db.upsertRepo({ installationId, ...r });
      try { results.push(await syncRepo(installationId, r, { force, token })); } catch (e) { results.push({ repo: r.fullName, error: e.message }); }
    }
    return results;
  }

  return { syncRepo, syncInstallation };
}
