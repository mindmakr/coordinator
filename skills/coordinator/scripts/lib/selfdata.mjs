// Reads what the coordinator's own page needs (lib/self.mjs): every run in
// the state folder, the lessons of both scopes, and the project's
// COORDINATOR.md. Read-only; a file that does not parse is skipped, never fatal.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS, loadRun } from './events.mjs';
import { baseDir, isSafeId, projectDir, readJson } from './store.mjs';

export const runsDir = () => join(baseDir('project'), 'runs');
const stateOf = (id) => join(runsDir(), id, 'state.json');
const lessonFiles = () => [...new Set([join(baseDir('global'), 'lessons.json'), join(baseDir('project'), 'lessons.json')])];
const contextFile = () => join(projectDir(), 'COORDINATOR.md');

export function runIds() {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir()).filter((d) => isSafeId(d) && (existsSync(stateOf(d)) || existsSync(join(runsDir(), d, EVENTS))));
}

export function loadRuns() {
  const out = [];
  for (const id of runIds()) {
    try { const s = loadRun(join(runsDir(), id)); if (s && Array.isArray(s.units)) out.push(s); } catch { /* unreadable: left out */ }
  }
  return out;
}

const safeRead = (f, fallback) => { try { return readJson(f, fallback); } catch { return fallback; } };

export function loadSelf() {
  const [global, project] = [join(baseDir('global'), 'lessons.json'), join(baseDir('project'), 'lessons.json')];
  let context = null;
  try { context = existsSync(contextFile()) ? readFileSync(contextFile(), 'utf8') : null; } catch { /* unreadable */ }
  return {
    runs: loadRuns(),
    lessons: { global: safeRead(global, []), project: global === project ? [] : safeRead(project, []) },
    context,
  };
}

// Changes when any run, lesson file or COORDINATOR.md changes: the live page's cue to re-render.
export function selfVersion() {
  const files = [...runIds().map(stateOf), ...lessonFiles(), contextFile()];
  return files.map((f) => { try { const st = statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');
}
