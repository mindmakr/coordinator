// c14: how many repo syncs run at once, and how many blob bytes they hold. One installation with
// hundreds of repos pushing at once used to start a sync for each, every one holding an 8 MB blob
// while it waited for a reader, until the process ran out of memory. Now:
// - at most `concurrency` syncs run at once (SYNC_CONCURRENCY), and at most `perInstallation` of
//   them for one installation (SYNC_PER_INSTALLATION), taken from the installations in turn, so one
//   installation's queue never stands in front of another's;
// - a sync asked for while the same repo is already queued joins the queued one (one result for
//   both), so a burst of pushes to one repo is one sync, not a queue of them;
// - a blob is fetched only once its bytes fit the budget of blob bytes held at once (SYNC_BLOB_MB),
//   and its bytes are held until it is read, so queued work holds references, never buffers.
//   A blob is charged BLOB_HOLD times its stored size: while one is read the process holds the base64
//   text of GitHub's answer, the parsed string, the decoded Buffer, the worker's copy and the text
//   the reader makes from it, about five copies in all.
// c14 round 5: a run's GitHub trail (tracker comments, board cards) is refreshed in a lane of its own
// (TRAIL_CONCURRENCY, TRAIL_PER_INSTALLATION), after the sync has given its slot back, so a pushed log
// that makes its trail slow cannot hold the slots other installations' syncs need. A sync job stops
// reading after SYNC_JOB_SECONDS and leaves the rest for the next sync; the trail's GitHub reads are
// budgeted per installation (TRAIL_READS per 10 minutes, trail.mjs) and the rest wait, like comment writes.

const envInt = (k, d, min, max, env = process.env) => {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`setting out of range: ${k}=${v} (${min}-${max})`);
  return n;
};
// The largest single blob read is a 16 MB map log (ingest.mjs LIMITS.mapBytes), so the budget is at least that.
export const BLOB_HOLD = 5;
export const syncSettings = (env = process.env) => ({
  concurrency: envInt('SYNC_CONCURRENCY', 4, 1, 64, env),
  perInstallation: envInt('SYNC_PER_INSTALLATION', 2, 1, 64, env),
  // Counted at BLOB_HOLD times each blob's size: 192 MB lets four 8 MB logs be read at once.
  blobBytes: envInt('SYNC_BLOB_MB', 192, 16, 4096, env) * 1024 * 1024,
  trailConcurrency: envInt('TRAIL_CONCURRENCY', 4, 1, 64, env),
  trailPerInstallation: envInt('TRAIL_PER_INSTALLATION', 1, 1, 64, env),
  trailReads: envInt('TRAIL_READS', 300, 10, 100_000, env),
  // Under an hour with the token's age (ingest.mjs TOKEN_REUSE_MS): an installation token lasts one.
  jobMs: envInt('SYNC_JOB_SECONDS', 300, 10, 1200, env) * 1000,
});

// Jobs per tenant (an installation) and key (a repo). submit(tenant, key, opts, run, merge) returns
// the job's promise; run(opts) does the work; merge(a, b) folds a later request's opts into a queued one.
export function syncQueue({ concurrency, perInstallation } = syncSettings()) {
  const queues = new Map(); // tenant -> [job], in order
  const ring = []; // tenants with queued jobs, in turn order
  const queued = new Map(); // key -> job not yet started
  const runningKeys = new Set();
  const active = new Map(); // tenant -> syncs running
  let busy = 0; let closed = false; let peak = 0;

  function next() {
    for (let i = 0; i < ring.length; i++) {
      const tenant = ring[i];
      if ((active.get(tenant) ?? 0) >= perInstallation) continue;
      const q = queues.get(tenant);
      const k = q.findIndex((j) => !runningKeys.has(j.key)); // one sync per repo at a time
      if (k < 0) continue;
      const [job] = q.splice(k, 1);
      ring.splice(i, 1);
      if (q.length) ring.push(tenant); else queues.delete(tenant);
      return job;
    }
    return null;
  }

  function pump() {
    while (busy < concurrency) {
      const job = next();
      if (!job) return;
      queued.delete(job.key); runningKeys.add(job.key);
      busy++; peak = Math.max(peak, busy);
      active.set(job.tenant, (active.get(job.tenant) ?? 0) + 1);
      Promise.resolve().then(() => job.run(job.opts)).then(job.ok, job.fail).finally(() => {
        busy--; runningKeys.delete(job.key);
        const n = active.get(job.tenant) - 1;
        if (n) active.set(job.tenant, n); else active.delete(job.tenant);
        pump();
      });
    }
  }

  return {
    submit(tenant, key, opts, run, merge = (a) => a) {
      if (closed) return Promise.reject(new Error('the sync queue is closed'));
      const same = queued.get(key);
      if (same) { same.opts = merge(same.opts, opts); return same.promise; }
      let ok; let fail;
      const promise = new Promise((a, b) => { ok = a; fail = b; });
      promise.catch(() => {}); // a refused job's caller may have gone; the rejection is still theirs to read
      const job = { tenant, key, opts, run, ok, fail, promise };
      queued.set(key, job);
      if (!queues.has(tenant)) { queues.set(tenant, []); ring.push(tenant); }
      queues.get(tenant).push(job);
      pump();
      return promise;
    },
    stats: () => ({ running: busy, queued: queued.size, peak }),
    // An installation removed: its queued jobs are refused (running ones check for themselves).
    drop(tenant, why = 'the installation was removed') {
      const q = queues.get(tenant);
      if (!q) return 0;
      queues.delete(tenant);
      const i = ring.indexOf(tenant); if (i >= 0) ring.splice(i, 1);
      for (const j of q) { queued.delete(j.key); j.fail(new Error(why)); }
      return q.length;
    },
    // Queued syncs are refused; running ones finish.
    close() {
      closed = true;
      for (const j of queued.values()) j.fail(new Error('the sync queue is closed'));
      queued.clear(); queues.clear(); ring.length = 0;
    },
  };
}

// Bytes held at once, at most max. take(n) waits its turn (first come, first served), so a large
// request is never passed over for ever by small ones; n is capped at max so it always fits alone.
export function byteBudget(max) {
  let used = 0; let peak = 0; const waiting = [];
  const grant = () => {
    while (waiting.length && used + waiting[0].n <= max) {
      const w = waiting.shift(); used += w.n; peak = Math.max(peak, used); w.ok();
    }
  };
  return {
    take(bytes) {
      const n = Math.min(Math.max(0, bytes), max);
      return new Promise((ok) => { waiting.push({ n, ok }); grant(); }).then(() => n);
    },
    give(n) { used -= n; grant(); },
    stats: () => ({ used, peak, max, waiting: waiting.length }),
  };
}
