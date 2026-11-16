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
// The git common folder (the main checkout's .git) for cwd, read from the files git itself reads, without starting
// git (every run.mjs call needs it; a git process costs ~20 ms): the nearest .git folder, or a worktree's .git file
// ("gitdir: …") and that folder's commondir. Undefined when git must be asked: GIT_DIR and friends set, or a .git
// that reads oddly. null: no .git up to the root.
export function gitCommonDir(cwd = process.cwd(), env = process.env) {
  if (env.GIT_DIR || env.GIT_COMMON_DIR || env.GIT_WORK_TREE || env.GIT_CEILING_DIRECTORIES || env.GIT_DISCOVERY_ACROSS_FILESYSTEM) return undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dot = join(dir, '.git');
    let st = null; try { st = statSync(dot); } catch { /* none here */ }
    if (st?.isDirectory()) return existsSync(join(dot, 'HEAD')) ? dot : undefined;
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, 'utf8'));
      if (!m) return undefined;
      const gitdir = resolve(dir, m[1]);
      if (!existsSync(join(gitdir, 'HEAD'))) return undefined;
      let common = gitdir; try { common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()); } catch { /* a submodule or a plain gitdir */ }
      return common;
    }
    if (dirname(dir) === dir) return null;
  }
}

// Cached per working folder: a process that calls the CLI in process (the tests) may ask from several.
const projectRoots = new Map();
function mainCheckout() {
  const cwd = process.cwd();
  if (!projectRoots.has(cwd)) {
    let root = cwd;
    let common = gitCommonDir(cwd);
    if (common === undefined) {
      try {
        // Plain --git-common-dir (any git version) may be relative to the cwd.
        common = resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      } catch { common = null; /* not a git checkout: the folder itself */ }
    }
    if (common && basename(common) === '.git') root = dirname(common);
    projectRoots.set(cwd, root);
  }
  return projectRoots.get(cwd);
}

// The project's folder (the main checkout), where COORDINATOR.md and the git remote live.
// COORDINATOR_PROJECT_DIR names the project for a process started outside it (run.mjs's background page writer, which
// must not hold the project folder as its working folder: Windows would refuse to delete it while it runs).
export const projectDir = () => (process.env.COORDINATOR_PROJECT_DIR ? resolve(process.env.COORDINATOR_PROJECT_DIR) : mainCheckout());

export function baseDir(scope = 'project') {
  if (process.env.COORDINATOR_DIR) return resolve(process.env.COORDINATOR_DIR);
  return scope === 'global' ? join(homedir(), '.coordinator') : join(projectDir(), '.coordinator');
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

// A lock held for as long as a long job runs (a full test suite), not seconds like withLock: it records who holds
// it (info, with this process's pid and a nonce) and is taken over only when that process is gone, or, with
// maxAgeMs, when its stamp is older than that (a reused pid). adopt(holder) true takes a lock handed to this process
// (lib/bgjob.mjs). Waits up to waitMs (onWait(holder) is told once), then throws "lock busy". Returns the function
// that releases it (only while the lock still carries this holder's nonce); release.nonce is that nonce.
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readRaw = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const parseHolder = (raw) => { try { const h = JSON.parse(raw); return h && typeof h === 'object' ? h : null; } catch { return null; } };
export function lockGone(holder, { alive = pidAlive, maxAgeMs = Infinity, now = Date.now } = {}) {
  if (!Number.isInteger(holder?.pid) || !alive(holder.pid)) return true;
  if (maxAgeMs === Infinity) return false;
  const at = Date.parse(holder.at);
  return !Number.isFinite(at) || now() - at >= maxAgeMs;
}
export function holdLock(file, info = {}, { waitMs = 60 * 60_000, onWait = null, alive = pidAlive, maxAgeMs = Infinity, adopt = null, now = Date.now } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const nonce = Math.random();
  const stamp = JSON.stringify({ ...info, pid: process.pid, at: new Date(now()).toISOString(), nonce });
  const deadline = Date.now() + waitMs;
  let told = false;
  for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
    try { const fd = openSync(file, 'wx'); writeSync(fd, stamp); closeSync(fd); break; } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      // Decide on one reading of the lock, and remove only that same content: a lock made since is left alone.
      const raw = readRaw(file);
      const holder = parseHolder(raw);
      if (holder && adopt?.(holder)) { writeAtomic(file, stamp); break; }
      if (holder && lockGone(holder, { alive, maxAgeMs, now })) {
        try { if (readRaw(file) === raw) unlinkSync(file); } catch { /* taken meanwhile */ }
        continue;
      }
      if (holder && !told) { told = true; onWait?.(holder); }
      if (Date.now() >= deadline) throw new Error(`lock busy: ${file}${holder ? ` (held by pid ${holder.pid} since ${holder.at})` : ''}`);
      pause(wait);
    }
  }
  const release = () => { try { if (parseHolder(readRaw(file))?.nonce === nonce) unlinkSync(file); } catch { /* already gone */ } };
  release.nonce = nonce;
  return release;
}
// Changes fields of a holdLock lock while it still carries `nonce` (a hand-over to another pid, a fresh stamp).
export function relabelLock(file, nonce, fields) {
  const h = parseHolder(readRaw(file));
  if (h?.nonce !== nonce) return false;
  writeAtomic(file, JSON.stringify({ ...h, ...fields }));
  return true;
}
// The lock's holder, when one holds it and is not gone.
export function lockHolder(file, opts = {}) {
  const h = parseHolder(readRaw(file));
  return h && !lockGone(h, opts) ? h : null;
}

// Removes a file if it is there.
export function removeFile(file) { try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }

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
