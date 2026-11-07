// The machine-wide run register: ~/.coordinator/registry.json (COORDINATOR_HOME
// overrides the folder). Every write to a run records it here, so the global
// coordinator page and `run.mjs list --all` show every run on this PC, across
// projects and tools. One entry per run: where it lives, its title, the name the
// person uses, the tool and skill version that last wrote it, and when.
// Written atomically under a lock (lib/store.mjs), so leads in different tools
// can write at once. It holds no secrets: titles are masked, and nothing else is text.
// Entries whose run folder is gone are pruned on every write and skipped on every read.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { maskSecrets } from './secrets.mjs';
import { withLock, writeJson } from './store.mjs';

export const REGISTRY = 'registry.json';
const FRESH_MS = 60_000; // an unchanged entry seen this recently is not rewritten

export const registryHome = (env = process.env) => resolve(env.COORDINATOR_HOME || join(homedir(), '.coordinator'));
export const registryFile = (home = registryHome()) => join(home, REGISTRY);

const norm = (p) => { const r = resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? r.toLowerCase() : r; };
// A short stable id for a state folder: the served pages name a project by it, never by its path.
export const projectKey = (stateDir) => createHash('sha256').update(norm(stateDir)).digest('hex').slice(0, 12);
const same = (a, b) => norm(a.stateDir) === norm(b.stateDir) && a.run === b.run;
const alive = (e) => { try { return existsSync(join(e.stateDir, 'runs', e.run)); } catch { return false; } };
const clean = (t, max = 200) => (typeof t === 'string' && t.trim() ? maskSecrets(t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max) : null);

function readFile(file) {
  if (!existsSync(file)) return [];
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(d?.runs) ? d.runs.filter((e) => e && typeof e.stateDir === 'string' && typeof e.run === 'string') : [];
  } catch { return null; }
}

// The entry for one run, from its state. stamp: { harness, skill }.
export function entryFor(s, { project, stateDir, stamp, at = new Date().toISOString() }) {
  return {
    run: s.id, project: resolve(project), stateDir: resolve(stateDir), key: projectKey(stateDir),
    title: clean(s.title ?? s.goal), alias: clean(s.alias, 80), tag: typeof s.tag === 'string' ? s.tag : null,
    harness: stamp?.harness ?? s.writer?.harness ?? null, skill: stamp?.skill ?? s.writer?.skill ?? null,
    startedIn: s.startedBy?.harness ?? null, closed: s.closed?.outcome ?? null, lastSeen: at,
  };
}

const unchanged = (a, b, now) => a && ['project', 'title', 'alias', 'tag', 'harness', 'skill', 'startedIn', 'closed'].every((k) => (a[k] ?? null) === (b[k] ?? null))
  && now - Date.parse(a.lastSeen ?? 0) < FRESH_MS;

// Records (or refreshes) one run. Returns true when it wrote.
export function register(entry, { home = registryHome(), now = Date.now() } = {}) {
  const file = registryFile(home);
  const seen = readFile(file);
  if (seen && unchanged(seen.find((e) => same(e, entry)), entry, now)) return false;
  withLock(file, () => {
    let runs = readFile(file);
    if (runs === null) { // unreadable: keep it aside and start again; each run re-registers on its next write
      try { renameSync(file, `${file}.bad-${now}`); } catch { /* gone meanwhile */ }
      runs = [];
    }
    runs = runs.filter((e) => !same(e, entry) && alive(e));
    runs.push(entry);
    runs.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    writeJson(file, { v: 1, note: 'Every coordinator run on this machine (run.mjs list --all). Written by run.mjs; safe to delete.', runs });
  });
  return true;
}

// Every registered run whose folder still exists, newest first. prune: also drop the rest from the file.
export function readRegistry({ home = registryHome(), prune = false } = {}) {
  const file = registryFile(home);
  const runs = readFile(file) ?? [];
  const live = runs.filter(alive);
  if (prune && live.length !== runs.length) {
    withLock(file, () => { const now = (readFile(file) ?? []).filter(alive); writeJson(file, { v: 1, note: 'Every coordinator run on this machine (run.mjs list --all). Written by run.mjs; safe to delete.', runs: now }); });
  }
  return live.map((e) => ({ ...e, key: projectKey(e.stateDir) }));
}

// Entries grouped by project (by state folder), the most recently active project first.
export function byProject(entries) {
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.key) ?? { key: e.key, project: e.project, stateDir: e.stateDir, runs: [] };
    g.runs.push(e); groups.set(e.key, g);
  }
  const latest = (g) => g.runs.reduce((m, r) => (String(r.lastSeen) > m ? String(r.lastSeen) : m), '');
  return [...groups.values()].sort((a, b) => latest(b).localeCompare(latest(a)));
}

export const findEntry = (entries, key, run) => entries.find((e) => e.key === key && e.run === run) ?? null;
