// Durable storage: validated ids, atomic writes, and a lock file so two
// writers never interleave. Everything the coordinator remembers goes through here.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i; // unusable file names on Windows
const LOCK_STALE_MS = 30_000;

export function isSafeId(id) {
  return typeof id === 'string' && ID.test(id) && !id.includes('..') && !RESERVED.test(id) && !id.endsWith('.');
}

export function safeId(id, what = 'id') {
  if (!isSafeId(id)) throw new Error(`invalid ${what}: ${id} (letters, digits, . _ - only)`);
  return id;
}

// The project's state lives beside the MAIN checkout, so a builder in any git
// worktree of the same repo reaches the lead's runs. COORDINATOR_DIR overrides
// both scopes (tests, a critic in a separate clone, a shared location).
let projectRoot;
function mainCheckout() {
  if (projectRoot === undefined) {
    try {
      // Plain --git-common-dir (any git version) may be relative to the cwd.
      const common = resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      projectRoot = basename(common) === '.git' ? dirname(common) : process.cwd();
    } catch { projectRoot = process.cwd(); }
  }
  return projectRoot;
}

// The project's folder (the main checkout), where COORDINATOR.md and the git remote live.
export const projectDir = () => mainCheckout();

export function baseDir(scope = 'project') {
  if (process.env.COORDINATOR_DIR) return resolve(process.env.COORDINATOR_DIR);
  return scope === 'global' ? join(homedir(), '.coordinator') : join(mainCheckout(), '.coordinator');
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Waits as long as a lock can be legitimately held, then takes over a stale
// one, but only if it is still the same stale lock (its stamp is unchanged).
export function withLock(file, fn) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const stamp = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + LOCK_STALE_MS + 5_000;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try { const fd = openSync(lock, 'wx'); writeSync(fd, stamp); closeSync(fd); break; } catch (e) {
      // EPERM or EACCES: on Windows, a lock file pending deletion by its last holder; busy, like EEXIST.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      try {
        const seen = readFileSync(lock, 'utf8');
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS && readFileSync(lock, 'utf8') === seen) unlinkSync(lock);
      } catch { /* released or taken meanwhile */ }
      if (Date.now() > deadline) throw new Error(`lock busy: ${lock}`);
      pause(wait);
    }
  }
  try { return fn(); } finally {
    try { if (readFileSync(lock, 'utf8') === stamp) unlinkSync(lock); } catch { /* already gone */ }
  }
}

export function readJson(file, fallback) {
  if (!existsSync(file)) return structuredClone(fallback);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  // On Windows a rename over a file another process has open (a reader that takes no lock,
  // such as the run register's fast path) fails for a moment with EPERM, EACCES or EBUSY: retry.
  for (let wait = 5; ; wait *= 2) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || wait > 640) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
      pause(wait);
    }
  }
}

export const writeJson = (file, data) => writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

// Read, change and write back under the lock. `mutate` may return a new value.
// `after` runs inside the same lock (e.g. to write a derived file).
export function update(file, fallback, mutate, after) {
  return withLock(file, () => {
    const data = readJson(file, fallback);
    const out = mutate(data) ?? data;
    writeJson(file, out);
    after?.(out);
    return out;
  });
}
