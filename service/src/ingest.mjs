// Reads a repo's coordinator-state branch into the read model. The event log is
// the run: each runs/<run>/events.jsonl is parsed and validated with the
// skill's own schema (core.mjs), replayed into state, masked again, and stored.
// Idempotent: the branch tip and each log's blob sha are compared first, so a
// redelivered webhook or a repeated sync changes nothing. A log that fails
// validation keeps the last good state and records why; other runs go on.
import { isSafeId, mapFromText, maskSecrets, parseLog, replay, unitRefs, validRun } from './core.mjs';
import { DEFERRED, parser } from './parser.mjs';

const RUN_LOG = /^runs\/([^/]+)\/events\.jsonl$/;
const MAP_LOG = /^runs\/([^/]+)\/map\/events\.jsonl$/;
const MARKER = '.coordinator-state';
const MB = 1024 * 1024;
// syncBytes: the run and map log bytes one sync of one repo reads (SYNC_MAX_MB); past it, the
// rest wait for the next sync, so one push of 500 large logs is read over several syncs.
const syncMb = (v = process.env.SYNC_MAX_MB) => {
  if (v === undefined || v === '') return 64;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 8 || n > 4096) throw new Error(`setting out of range: SYNC_MAX_MB=${v} (8-4096)`);
  return n;
};
export const LIMITS = { mapBytes: 16 * MB, logBytes: 8 * MB, runs: 500, lessonsBytes: MB, configBytes: 64 * 1024, syncBytes: syncMb() * MB };

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

const why = (e, n = 500) => maskSecrets(String(e?.message ?? e).slice(0, 2 * n)).slice(0, n);

// The run a log describes, or an error message. Never throws. Pure: parser.mjs runs it in a worker.
export function readLog(runId, buf) {
  try {
    const named = firstRunId(buf); // cheap: the first line only, before parsing, replaying and masking
    if (named !== null && named !== runId) return { error: `the log describes run ${JSON.stringify(String(named).slice(0, 64))}, not ${runId}` };
    const log = parseLog(buf, `runs/${runId}/events.jsonl`);
    if (!log.events.length) return { error: 'the event log is empty' };
    const state = replay(log.events);
    const err = validRun(state);
    if (err) return { error: `the replayed state is not a run: ${err}` };
    if (state.id !== runId) return { error: `the log describes run ${JSON.stringify(String(state.id).slice(0, 64))}, not ${runId}` };
    if (state.units.length > MAX_UNITS) return { error: `the run has ${state.units.length} units; at most ${MAX_UNITS} are read` };
    return { state: maskDeep(state), seq: log.events.length };
  } catch (e) { return { error: why(e) }; }
}

// The run id the log's first event (run.init) sets, or null when the first line does not say plainly.
function firstRunId(buf) {
  const nl = buf.indexOf(10);
  if (nl < 0 || nl > LIMITS.logBytes) return null;
  try {
    const e = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    const op = e?.kind === 'run.init' && Array.isArray(e.payload?.ops) ? e.payload.ops[0] : null;
    return op?.op === 'set' && Array.isArray(op.path) && op.path.length === 0 && typeof op.value?.id === 'string' ? op.value.id : null;
  } catch { return null; }
}

// The project map a run pushed (lib/map), or an error message. Never throws.
export function readMap(buf) {
  try { return { map: maskDeep(mapFromText(buf.toString('utf8'), 'map/events.jsonl')) }; } catch (e) { return { error: why(e) }; }
}

// lessons/lessons.json or coordinator.json, shaped and masked: { value } or { error }. Never throws.
export function readJson(kind, buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    return { value: kind === 'lessons' ? (Array.isArray(j) ? maskDeep(j.filter(isObj)) : null) : (isObj(j) ? maskDeep(j) : null) };
  } catch (e) { return { error: why(e, 200) }; }
}

// The issues and PRs each unit links, as rows for db.setUnitRefs: at most MAX_REFS_PER_UNIT per unit,
// the same cap the trail writes under (trail.mjs CAPS.refsPerUnit), so one log cannot fan out into
// thousands of rows or of access checks on a page view.
export const MAX_REFS_PER_UNIT = 10;
// A trail refresh still owes GitHub a write when a comment was held back by the write budget,
// or when the refresh failed partway (out.error, e.g. a GitHub 5xx).
export const trailOwed = (r) => Boolean(r?.error) || (r?.comments ?? []).some((c) => c[2] === 'deferred');
export const refsOf = (state) => state.units.flatMap((u) => unitRefs(u).slice(0, MAX_REFS_PER_UNIT).map((x) => ({ unit: u.id, key: x.key })));

// trail (optional): { refreshRun(installationId, repo, runId) }, run for every run whose state changed,
// and again at every later sync for a run whose last refresh held a comment back (db trailPending),
// even when the branch tip has not moved.
//
// Every trail refresh of a repo's runs, from a sync or from a webhook (refreshRuns), is a retrail in
// that repo's serial queue, so two never overlap. The flag is set before each refresh
// (markTrailPending gives the run a new trailSeq from one global counter) and cleared only by a
// refresh that finished cleanly, and then only if trailSeq still holds the value it set: a deferral
// recorded meanwhile (by another process sharing the database) is never overwritten, a crash
// mid-refresh leaves the run owed, and a run dropped and re-created never gets an old value back.
// onChange (optional, c12 doorbell and alerts): (installationId, repo, [{ runId, before, after }]) after a sync
// that changed runs; it must not throw (the server runs its work in the background).
// parse (tests): the readers; by default parser.mjs, which runs them in a worker thread with a timeout.
export function ingester({ db, gh, branch = 'coordinator-state', log, trail = null, onChange = null, parse = null }) {
  const reader = parse ?? parser();
  const chains = new Map(); // one sync or trail refresh per repo at a time; a second waits for the first
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
      if (!force && current?.headSha === head) {
        const retried = await retrail(installationId, current, []);
        return { repo: repo.fullName, head, unchanged: true, ...(retried.length ? { retried } : {}) };
      }
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
      const changes = [];
      // A log left for later (the sync's byte cap, or the installation's reading budget) keeps its last
      // state, and the repo keeps its old head, so the next sync or resync reads it.
      const later = []; const reasons = new Set(); let bytes = 0;
      const fits = (size) => { if (bytes && bytes + size > LIMITS.syncBytes) { reasons.add(`this sync read its ${LIMITS.syncBytes / MB} MB`); return false; } bytes += size; return true; };
      for (const e of logs) {
        const prev = have.get(e.runId);
        if (prev?.eventsSha === e.sha && !force) continue; // same bytes, same result
        if (e.size <= LIMITS.logBytes && !fits(e.size)) { later.push(e.runId); continue; }
        const r = e.size > LIMITS.logBytes ? { error: `the event log is larger than ${LIMITS.logBytes} bytes` } : await reader.readLog(e.runId, await gh.blob(token, repo.fullName, e.sha), installationId);
        if (r.deferred) { later.push(e.runId); reasons.add(DEFERRED); continue; }
        if (r.error) {
          // Keep the last good state; record the failure against this blob.
          await db.putRun(installationId, repo.id, { runId: e.runId, eventsSha: e.sha, seq: prev?.seq ?? null, state: prev?.state ?? null, error: r.error });
          out.failed.push(e.runId);
          log?.warn('run log rejected', { repo: repo.fullName, run: e.runId, reason: r.error });
        } else {
          await db.putRun(installationId, repo.id, { runId: e.runId, eventsSha: e.sha, seq: r.seq, state: r.state, error: null });
          await db.setUnitRefs(installationId, repo.id, e.runId, refsOf(r.state));
          out.updated.push(e.runId);
          changes.push({ runId: e.runId, before: prev?.state ?? null, after: r.state });
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
        if (e.size <= LIMITS.mapBytes && !fits(e.size)) { later.push(`${runId} (map)`); continue; }
        const r = e.size > LIMITS.mapBytes ? { error: `the map log is larger than ${LIMITS.mapBytes} bytes` } : await reader.readMap(await gh.blob(token, repo.fullName, e.sha), installationId);
        if (r.deferred) { later.push(`${runId} (map)`); reasons.add(DEFERRED); continue; }
        await db.putRunMap(installationId, repo.id, runId, { mapSha: e.sha, map: r.map ?? prev.map ?? null, mapError: r.error ?? null });
        if (r.error) log?.warn('map log rejected', { repo: repo.fullName, run: runId, reason: r.error });
      }
      // Lessons and coordinator.json are optional: one that cannot be read is left out and named in the sync error.
      const lessons = await readSide(installationId, token, repo, entries, 'lessons/lessons.json', LIMITS.lessonsBytes, 'lessons');
      const config = await readSide(installationId, token, repo, entries, 'coordinator.json', LIMITS.configBytes, 'config');
      if (lessons.deferred || config.deferred) { later.push('side files'); reasons.add(DEFERRED); }
      const owed = later.length ? `${later.length} file${later.length === 1 ? '' : 's'} left for the next sync: ${[...reasons].join('; ')}` : null;
      if (owed) { out.later = later; log?.warn('sync left logs for later', { repo: repo.fullName, installation: installationId, later: later.slice(0, 20), count: later.length }); }
      const errors = [tree.truncated ? 'the branch tree was too large to read whole; some runs may be missing' : null, owed, lessons.error, config.error].filter(Boolean);
      // With logs left over the old head stays, so the next sync (a push, a write or the resync) is not skipped as unchanged.
      const side = { ...(lessons.deferred ? {} : { lessons: lessons.value }), ...(config.deferred ? {} : { config: config.value }) };
      await db.setRepoSync(installationId, repo.id, { headSha: later.length ? (current?.headSha ?? null) : head, error: errors.length ? errors.join('; ') : null, ...side });
      const fresh = (await db.repos(installationId)).find((x) => x.id === repo.id);
      if (onChange && changes.length) onChange(installationId, fresh ?? repo, changes);
      const retried = await retrail(installationId, fresh, out.updated);
      if (retried.length) out.retried = retried;
      return out;
    });
  }

  // Refreshes the trail of the changed runs plus every run still owed a comment, and records which
  // ones still are. The flag lives in the read model, so a restart keeps it; the tracker rows keep
  // the comment ids, so a retry edits or adopts the comment and never posts a second one.
  // Called inside the repo's queue only. Refreshes `changed` (plus, with `owedToo`, every other run still
  // owed) as whole runs. Each run is marked owed first (a new trailSeq) and cleared by a clean finish,
  // and then only if no deferral was recorded since (trailSeq still the one this refresh set).
  async function retrail(installationId, repo, changed, { owedToo = true } = {}) {
    if (!trail || !repo) return [];
    const owed = (await db.runs(installationId, repo.id)).filter((r) => r.trailPending).map((r) => r.runId);
    const retried = owedToo ? owed.filter((id) => !changed.includes(id)) : [];
    for (const runId of [...changed, ...retried]) {
      // Marked before the refresh, cleared after a clean one: a crash between a deferred write and
      // its mark cannot lose the write. The clear holds only if nobody marked the run meanwhile.
      const seq = await db.markTrailPending(installationId, repo.id, runId);
      const r = await trail.refreshRun(installationId, repo, runId);
      if (!trailOwed(r) && seq !== null) await db.clearTrailPending(installationId, repo.id, runId, seq);
    }
    return retried;
  }

  // A webhook's refresh (a linked PR merged, closed or finished its checks): the same retrail, queued
  // behind any sync or other refresh of the same repo, for the runs that link the PR.
  async function refreshRuns(installationId, repoId, runIds) {
    if (!trail) return;
    await serial(`${installationId}:${repoId}`, async () => {
      await retrail(installationId, (await db.repos(installationId)).find((x) => x.id === repoId), runIds, { owedToo: false });
    });
  }

  // { value, error }: never throws, whatever the file holds.
  async function readSide(installationId, token, repo, entries, path, max, kind) {
    const e = entries.find((x) => x.path === path && x.type === 'blob');
    if (!e) return { value: null };
    if (e.size > max) return { value: null, error: `${path}: larger than ${max} bytes` };
    let r;
    try { r = await reader.readJson(kind, await gh.blob(token, repo.fullName, e.sha), installationId); } catch (err) { r = { error: why(err, 200) }; }
    if (r.deferred) return { value: null, deferred: true };
    return r.error ? { value: null, error: `${path}: ${r.error}` } : { value: r.value ?? null };
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

  return { syncRepo, syncInstallation, refreshRuns, close: () => reader.close() };
}
