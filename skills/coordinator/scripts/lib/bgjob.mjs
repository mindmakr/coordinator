// A job one background process does at a time, for any number of callers (run.mjs: coordinator.html after a
// change). A caller stamps `want` and makes sure a writer runs; the writer works until the stamp it covered, `done`,
// is the latest, so a burst of changes costs one or two runs of the job. The lock is store.mjs's holdLock: the caller
// takes it with a hand-over id before starting the writer and relabels it with the writer's pid; the writer adopts
// a lock that carries its hand-over id, whoever's pid is on it. So a change made while the writer starts starts no
// other, and a writer that starts before the relabel still gets its lock. A holder that is gone, or older than
// maxAgeMs (a reused pid), is taken over. Every write goes through store.mjs.
import { holdLock, lockHolder, readJson, relabelLock, removeFile, writeAtomic } from './store.mjs';

export const MAX_AGE_MS = 5 * 60_000;
const read = (file) => { try { return String(readJson(file, '')); } catch { return ''; } };
const stampText = () => JSON.stringify(`${process.pid} ${Date.now()} ${Math.random()}`);
const busy = (e) => /^lock busy/.test(e?.message ?? '');

// Whether a live writer holds the lock (alive pid, stamp younger than maxAgeMs).
export const live = (lock, opts = {}) => lockHolder(lock, { maxAgeMs: MAX_AGE_MS, ...opts }) !== null;

// The caller's side. files: { want, done, lock }; start(handover): starts the writer, passing it the hand-over id,
// and returns its pid (throws when it cannot). Returns 'running' (a live writer will see the stamp) or 'started'.
// A start that fails leaves no lock behind.
export function queue(files, start, opts = {}) {
  writeAtomic(files.want, stampText());
  const handover = `h${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let release;
  try { release = holdLock(files.lock, { handover }, { waitMs: 0, maxAgeMs: MAX_AGE_MS, ...opts }); } catch (e) { if (busy(e)) return 'running'; throw e; }
  let pid;
  try { pid = start(handover); } catch (e) { release(); throw e; }
  if (!Number.isInteger(pid)) { release(); throw new Error('the background writer did not start'); }
  relabelLock(files.lock, release.nonce, { pid, at: new Date().toISOString() }); // unless the writer adopted it already
  return 'started';
}

// The writer's side. run() does the job, or throws. handover: the id its caller passed (none when run by hand).
// Returns 'done', 'busy' (another writer has it) or 'failed' (the stamp stays uncovered, so the next change tries
// again; the error is kept in `files.error`).
export function drain(files, run, { handover = null, ...opts } = {}) {
  for (;;) {
    let release;
    const adopt = handover ? (h) => h.handover === handover : null;
    try { release = holdLock(files.lock, { writer: true }, { waitMs: 0, maxAgeMs: MAX_AGE_MS, adopt, ...opts }); } catch (e) { if (busy(e)) return 'busy'; throw e; }
    try {
      for (;;) {
        const want = read(files.want);
        if (want === read(files.done)) break;
        relabelLock(files.lock, release.nonce, { at: new Date().toISOString() }); // still working: not too old
        try { run(); } catch (e) {
          if (files.error) writeAtomic(files.error, `${new Date().toISOString()} ${e?.message ?? e}\n`);
          return 'failed';
        }
        if (files.error) removeFile(files.error);
        writeAtomic(files.done, JSON.stringify(want));
        if (read(files.want) === want) break;
      }
    } finally { release(); }
    // A stamp written while this writer was letting go: its caller saw the lock held and started none.
    if (read(files.want) === read(files.done)) return 'done';
  }
}
