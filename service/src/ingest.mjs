// Reads a repo's coordinator-state branch into the read model. The event log is
// the run: each runs/<run>/events.jsonl is parsed and validated with the
// skill's own schema (core.mjs), replayed into state, masked again, and stored.
// Idempotent: the branch tip and each log's blob sha are compared first, so a
// redelivered webhook or a repeated sync changes nothing. A log that fails
// validation keeps the last good state and records why; other runs go on.
import { isSafeId, mapFromText, maskSecrets, parseLog, replay, unitRefs, validRun } from './core.mjs';

const RUN_LOG = /^runs\/([^/]+)\/events\.jsonl$/;
const MAP_LOG = /^runs\/([^/]+)\/map\/events\.jsonl$/;
const MARKER = '.coordinator-state';
export const LIMITS = { mapBytes: 16 * 1024 * 1024, logBytes: 8 * 1024 * 1024, runs: 500, lessonsBytes: 1024 * 1024, configBytes: 64 * 1024 };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const MAX_DEPTH = 64;
export const MAX_UNITS = 50; // a run past this is refused, so one log cannot fan out into thousands of writes
// Masks every string; anything nested deeper than MAX_DEPTH is refused with an Error, never a stack overflow.
export function maskDeep(v, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`nested deeper than ${MAX_DEPTH} levels`);
  if (typeof v === 'string') return maskSecrets(v);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, depth + 1)]));
  return v;
}

// The run a log describes, or an error message. Never throws.
export function readLog(runId, buf) {
  try {
    const log = parseLog(buf, `runs/${runId}/events.jsonl`);
    if (!log.events.length) return { error: 'the event log is empty' };
    const state = replay(log.events);
    const err = validRun(state);
    if (err) return { error: `the replayed state is not a run: ${err}` };
    if (state.id !== runId) return { error: `the log describes run ${JSON.stringify(String(state.id).slice(0, 64))}, not ${runId}` };
    if (state.units.length > MAX_UNITS) return { error: `the run has ${state.units.length} units; at most ${MAX_UNITS} are read` };
    return { state: maskDeep(state), seq: log.events.length };
  } catch (e) { return { error: maskSecrets(String(e.message)).slice(0, 500) }; }
}

// The project map a run pushed (lib/map), or an error message. Never throws.
export function readMap(buf) {
  try { return { map: maskDeep(mapFromText(buf.toString('utf8'), 'map/events.jsonl')) }; } catch (e) { return { error: maskSecrets(String(e.message)).slice(0, 500) }; }
}

// The issues and PRs each unit links, as rows for db.setUnitRefs.
export const refsOf = (state) => state.units.flatMap((u) => unitRefs(u).map((x) => ({ unit: u.id, key: x.key })));

// trail (optional): { refreshRun(installationId, repo, runId) }, run for every run whose state changed.
export function ingester({ db, gh, branch = 'coordinator-state', log, trail = null }) {
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
          await db.setUnitRefs(installationId, repo.id, e.runId, refsOf(r.state));
          out.updated.push(e.runId);
        }
      }
      await db.dropRunsExcept(installationId, repo.id, logs.map((e) => e.runId));
      // Each run's project map, when it pushed one: same rules, keyed by its own blob.
      const runIds = new Set(logs.map((e) => e.runId));
      const rows = new Map((await db.runs(installationId, repo.id)).map((r) => [r.runId, r]));
      for (const e of entries.filter((x) => x.type === 'blob' && MAP_LOG.test(x.path))) {
        const runId = MAP_LOG.exec(e.path)[1];
        const prev = rows.get(runId);
        if (!runIds.has(runId) || !prev || (prev.mapSha === e.sha && !force)) continue;
        const r = e.size > LIMITS.mapBytes ? { error: `the map log is larger than ${LIMITS.mapBytes} bytes` } : readMap(await gh.blob(token, repo.fullName, e.sha));
        await db.putRunMap(installationId, repo.id, runId, { mapSha: e.sha, map: r.map ?? prev.map ?? null, mapError: r.error ?? null });
        if (r.error) log?.warn('map log rejected', { repo: repo.fullName, run: runId, reason: r.error });
      }
      // Lessons and coordinator.json are optional: one that cannot be read is left out and named in the sync error.
      const lessons = await readSide(token, repo, entries, 'lessons/lessons.json', LIMITS.lessonsBytes, (j) => (Array.isArray(j) ? maskDeep(j.filter(isObj)) : null));
      const config = await readSide(token, repo, entries, 'coordinator.json', LIMITS.configBytes, (j) => (isObj(j) ? maskDeep(j) : null));
      const errors = [tree.truncated ? 'the branch tree was too large to read whole; some runs may be missing' : null, lessons.error, config.error].filter(Boolean);
      await db.setRepoSync(installationId, repo.id, { headSha: head, error: errors.length ? errors.join('; ') : null, lessons: lessons.value, config: config.value });
      if (trail && out.updated.length) {
        const fresh = (await db.repos(installationId)).find((x) => x.id === repo.id);
        for (const runId of out.updated) await trail.refreshRun(installationId, fresh, runId);
      }
      return out;
    });
  }

  // { value, error }: never throws, whatever the file holds.
  async function readSide(token, repo, entries, path, max, shape) {
    const e = entries.find((x) => x.path === path && x.type === 'blob');
    if (!e) return { value: null };
    if (e.size > max) return { value: null, error: `${path}: larger than ${max} bytes` };
    try { return { value: shape(JSON.parse((await gh.blob(token, repo.fullName, e.sha)).toString('utf8'))) }; } catch (err) {
      return { value: null, error: `${path}: ${maskSecrets(String(err.message)).slice(0, 200)}` };
    }
  }

  // Every repo the installation can reach now: new ones added, gone ones removed, each synced.
  async function syncInstallation(installationId, { force = false } = {}) {
    const token = await gh.installationToken(installationId);
    const seen = [];
    for await (const r of gh.installationRepos(token)) seen.push({ id: r.id, fullName: r.full_name, private: typeof r.private === 'boolean' ? r.private : undefined });
    const known = await db.repos(installationId);
    for (const r of known) if (!seen.some((s) => s.id === r.id)) await db.removeRepo(installationId, r.id);
    const results = [];
    for (const r of seen) await db.upsertRepo({ installationId, ...r }); // all first, so links between them resolve
    for (const r of seen) {
      try { results.push(await syncRepo(installationId, { id: r.id, fullName: r.fullName }, { force, token })); } catch (e) { results.push({ repo: r.fullName, error: e.message }); }
    }
    return results;
  }

  return { syncRepo, syncInstallation };
}
