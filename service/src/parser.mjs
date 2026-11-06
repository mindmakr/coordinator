// Reading a run log, a map log or a side file (parse, validate, replay, mask) runs in a worker
// thread, so a log built to be slow costs one worker, never the event loop that serves every
// other tenant. One read at a time; one that takes longer than timeoutMs ends the worker (a
// fresh one starts for the next read) and comes back as an error, like any unreadable log.
import { Worker } from 'node:worker_threads';

export const PARSE_TIMEOUT_MS = 20_000;
const IDLE_MS = 30_000; // an idle worker is ended; the next read starts a new one
const WORKER = new URL('./parse-worker.mjs', import.meta.url);

export function parser({ timeoutMs = PARSE_TIMEOUT_MS } = {}) {
  let worker = null; let chain = Promise.resolve(); let seq = 0; let busy = 0; let idle = null;
  const start = () => {
    const w = new Worker(WORKER);
    w.unref(); // an idle reader never keeps the process alive
    w.on('error', () => { if (worker === w) worker = null; });
    w.on('exit', () => { if (worker === w) worker = null; });
    return w;
  };
  function call(op, args) {
    const run = () => new Promise((ok) => {
      worker ??= start();
      const w = worker; const id = ++seq;
      const done = (r) => { clearTimeout(timer); w.off('message', onMsg); w.off('exit', onExit); w.unref(); ok(r); };
      clearTimeout(idle);
      const onMsg = (m) => { if (m.id === id) done(m.result); };
      const onExit = () => done({ error: 'the reader stopped before it finished' });
      const timer = setTimeout(() => { worker = null; w.terminate().catch(() => {}); done({ error: `reading it took longer than ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
      w.on('message', onMsg); w.on('exit', onExit); w.ref();
      w.postMessage({ id, op, args });
    });
    busy++;
    const p = chain.then(run, run).finally(() => {
      if (--busy) return;
      idle = setTimeout(() => { const w = worker; worker = null; w?.terminate().catch(() => {}); }, IDLE_MS);
      idle.unref?.();
    });
    chain = p;
    return p;
  }
  return {
    readLog: (runId, buf) => call('log', [runId, buf]),
    readMap: (buf) => call('map', [buf]),
    // kind 'lessons' | 'config': the JSON file shaped and masked as ingest.mjs does.
    readJson: (kind, buf) => call('json', [kind, buf]),
    async close() { clearTimeout(idle); const w = worker; worker = null; if (w) await w.terminate(); },
  };
}
