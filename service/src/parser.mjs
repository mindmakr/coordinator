// Reading a run log, a map log or a side file (parse, validate, replay, mask) runs in a small pool of
// worker threads, so a log built to be slow costs a worker, never the event loop that serves every
// tenant. The pool is shared fairly (c14 round 3):
// - each installation has its own queue, and free workers take from the queues in turn (round-robin),
//   so one installation's hundred reads wait behind each other, not in front of everyone else's;
// - a large read (more than smallBytes) may use every worker but one, so a small read always finds a
//   worker within the time of one small read, however many large ones are queued;
// - each installation has a parse-time budget per hour; past it, its reads are refused as deferred
//   (ingest.mjs keeps the repo owed, and the next resync reads it again);
// - one read that takes longer than timeoutMs ends its worker (a fresh one starts) and is an error.
import { Worker } from 'node:worker_threads';

export const PARSE_TIMEOUT_MS = 20_000;
const IDLE_MS = 30_000; // an idle worker is ended; the next read starts a new one
const HOUR = 3_600_000;
const WORKER = new URL('./parse-worker.mjs', import.meta.url);

const envInt = (k, d, min, max, env = process.env) => {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`setting out of range: ${k}=${v} (${min}-${max})`);
  return n;
};
// The settings, from the environment (.env.example): PARSE_WORKERS, PARSE_BUDGET_SECONDS, PARSE_SMALL_KB.
export const parserSettings = (env = process.env) => ({
  workers: envInt('PARSE_WORKERS', 2, 1, 32, env),
  budgetMs: envInt('PARSE_BUDGET_SECONDS', 600, 1, 3600, env) * 1000,
  smallBytes: envInt('PARSE_SMALL_KB', 512, 1, 16 * 1024, env) * 1024,
});
export const DEFERRED = 'this installation used its reading time for the hour; it is read again at the next resync';

export function parser({ timeoutMs = PARSE_TIMEOUT_MS, now = Date.now, ...over } = {}) {
  const { workers, budgetMs, smallBytes } = { ...parserSettings(), ...over };
  const slots = Array.from({ length: workers }, () => ({ worker: null, busy: false, idle: null }));
  const queues = new Map(); // tenant -> [job]
  const ring = []; // tenants with queued jobs, in turn order
  const spent = new Map(); // tenant -> { from, ms }: reading time used in the current hour
  let seq = 0; let largeBusy = 0; let closed = false;

  const used = (tenant) => {
    const s = spent.get(tenant);
    if (s && now() - s.from >= HOUR) { spent.delete(tenant); return 0; }
    return s?.ms ?? 0;
  };
  const charge = (tenant, ms) => {
    used(tenant);
    const s = spent.get(tenant) ?? { from: now(), ms: 0 };
    s.ms += ms; spent.set(tenant, s);
  };
  const start = (slot) => {
    const w = new Worker(WORKER);
    w.unref(); // an idle reader never keeps the process alive
    const gone = () => { if (slot.worker === w) slot.worker = null; };
    w.on('error', gone); w.on('exit', gone);
    return w;
  };

  // The next job a free slot may take: tenants in turn; a large job only while another slot stays free for small ones.
  function next() {
    const largeOk = workers === 1 || largeBusy < workers - 1;
    for (let i = 0; i < ring.length; i++) {
      const tenant = ring[i]; const q = queues.get(tenant);
      const k = q.findIndex((j) => largeOk || !j.large);
      if (k < 0) continue;
      const [job] = q.splice(k, 1);
      ring.splice(i, 1);
      if (q.length) ring.push(tenant); else queues.delete(tenant);
      return job;
    }
    return null;
  }

  function pump() {
    for (;;) {
      const free = slots.filter((s) => !s.busy);
      if (!free.length || !ring.length) return;
      const job = next();
      if (!job) return;
      if (used(job.tenant) >= budgetMs) { job.ok({ error: DEFERRED, deferred: true }); continue; }
      run(free[0], job);
    }
  }

  function run(slot, job) {
    slot.busy = true; if (job.large) largeBusy++;
    clearTimeout(slot.idle);
    slot.worker ??= start(slot);
    const w = slot.worker; const id = ++seq; const began = now();
    const done = (r) => {
      clearTimeout(timer); w.off('message', onMsg); w.off('exit', onExit); w.unref();
      charge(job.tenant, Math.max(0, now() - began));
      slot.busy = false; if (job.large) largeBusy--;
      slot.idle = setTimeout(() => { if (slot.busy) return; const x = slot.worker; slot.worker = null; x?.terminate().catch(() => {}); }, IDLE_MS);
      slot.idle.unref?.();
      job.ok(r);
      pump();
    };
    const onMsg = (m) => { if (m.id === id) done(m.result); };
    const onExit = () => done({ error: 'the reader stopped before it finished' });
    const timer = setTimeout(() => { slot.worker = null; w.terminate().catch(() => {}); done({ error: `reading it took longer than ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    w.on('message', onMsg); w.on('exit', onExit); w.ref();
    w.postMessage({ id, op: job.op, args: job.args });
  }

  // tenant: the installation the read is for (its queue and its budget).
  function call(tenant, op, args, bytes) {
    if (closed) return Promise.resolve({ error: 'the reader is closed' });
    return new Promise((ok) => {
      const key = String(tenant ?? '');
      if (!queues.has(key)) { queues.set(key, []); ring.push(key); }
      queues.get(key).push({ tenant: key, op, args, large: bytes > smallBytes, ok });
      pump();
    });
  }
  return {
    readLog: (runId, buf, tenant) => call(tenant, 'log', [runId, buf], buf.length),
    readMap: (buf, tenant) => call(tenant, 'map', [buf], buf.length),
    // kind 'lessons' | 'config': the JSON file shaped and masked as ingest.mjs does.
    readJson: (kind, buf, tenant) => call(tenant, 'json', [kind, buf], buf.length),
    // Reading time an installation used in the current hour, in ms (tests, logs).
    spent: (tenant) => used(String(tenant ?? '')),
    // Ends every worker; reads still queued come back as errors, and later reads are refused.
    async close() {
      closed = true;
      for (const [, q] of queues) for (const j of q) j.ok({ error: 'the reader is closed' });
      queues.clear(); ring.length = 0;
      await Promise.all(slots.map(async (s) => { clearTimeout(s.idle); const w = s.worker; s.worker = null; if (w) await w.terminate(); }));
    },
  };
}
