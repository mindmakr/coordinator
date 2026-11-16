// A job one background process does at a time, for any number of callers (run.mjs: coordinator.html after a
// change). A caller stamps `want` and makes sure a writer runs; the writer works until the stamp it covered, `done`,
// is the latest, so a burst of changes costs one or two runs of the job. The lock names the writer's pid: the caller
// claims it before starting the writer and hands it over (the writer adopts a lock that names its own pid), so a
// change made while the writer is still starting starts no second one. A lock whose holder is gone, or older than
// maxAgeMs (a reused pid), is taken over. Writes go through store.mjs; the process is started by the caller's start().
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { pidAlive, writeAtomic } from './store.mjs';

export const MAX_AGE_MS = 5 * 60_000;
const read = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const holderOf = (lock) => { try { const h = JSON.parse(readFileSync(lock, 'utf8')); return Number.isInteger(h?.pid) ? h : null; } catch { return null; } };

// Whether the lock's holder is a live writer: its pid is alive and its stamp is younger than maxAgeMs.
export function live(lock, { alive = pidAlive, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
  const h = holderOf(lock);
  if (!h) return false;
  const at = Date.parse(h.at);
  return alive(h.pid) && Number.isFinite(at) && now() - at < maxAgeMs;
}

// Creates the lock for pid; false when another live writer holds it. A gone or too old holder is removed first.
function claim(lock, pid, opts) {
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(lock, 'wx'); writeSync(fd, JSON.stringify({ pid, at: new Date(opts.now?.() ?? Date.now()).toISOString(), nonce: Math.random() })); closeSync(fd); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (live(lock, opts)) return false;
      const stale = read(lock);
      try { if (read(lock) === stale) unlinkSync(lock); } catch { /* taken meanwhile */ }
    }
  }
  return false;
}
const restamp = (lock, pid, opts) => writeAtomic(lock, JSON.stringify({ pid, at: new Date(opts.now?.() ?? Date.now()).toISOString(), nonce: Math.random() }));
const releaseIf = (lock, pid) => { try { if (holderOf(lock)?.pid === pid) unlinkSync(lock); } catch { /* gone */ } };

// The caller's side. files: { want, done, lock }; start(): starts the writer and returns its pid (throws when it
// cannot). Returns 'running' (a live writer will see the stamp), or 'started'. A start that fails leaves no lock.
export function queue(files, start, opts = {}) {
  writeAtomic(files.want, `${process.pid} ${Date.now()} ${Math.random()}\n`);
  if (!claim(files.lock, process.pid, opts)) return 'running';
  let pid;
  try { pid = start(); } catch (e) { releaseIf(files.lock, process.pid); throw e; }
  if (!Number.isInteger(pid)) { releaseIf(files.lock, process.pid); throw new Error('the background writer did not start'); }
  restamp(files.lock, pid, opts); // handed over: the writer adopts it
  return 'started';
}

// The writer's side. run() does the job and returns true, or throws. Returns 'done', 'busy' (another writer has it)
// or 'failed' (the stamp stays uncovered, so the next caller tries again; the error is in `files.error`).
export function drain(files, run, opts = {}) {
  const me = opts.pid ?? process.pid;
  for (;;) {
    const mine = holderOf(files.lock)?.pid === me || claim(files.lock, me, opts);
    if (!mine) return 'busy';
    try {
      for (;;) {
        const want = read(files.want);
        if (want === read(files.done)) break;
        restamp(files.lock, me, opts); // still working: not too old for the next caller
        try { run(); } catch (e) {
          if (files.error) writeAtomic(files.error, `${new Date().toISOString()} ${e?.message ?? e}\n`);
          return 'failed';
        }
        if (files.error) { try { unlinkSync(files.error); } catch { /* none */ } }
        writeAtomic(files.done, want);
        if (read(files.want) === want) break;
      }
    } finally { releaseIf(files.lock, me); }
    // A stamp written while this writer was letting go: its caller saw the lock held and started none.
    if (read(files.want) === read(files.done)) return 'done';
  }
}
