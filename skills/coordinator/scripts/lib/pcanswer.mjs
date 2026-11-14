// Answers given on the PC dashboard (`run.mjs dashboard`, design one-boss 5.4) for a run of any
// registered project. The form names a project only by its key in the register, a run id and a
// question id, never a folder: the state folder comes from the register alone. What the form asks
// is checked here first, so a refused post writes nothing; the write itself is `run.mjs answer`
// run with COORDINATOR_DIR set to that state folder, the same locked code as an answer typed on
// the CLI. That child records the answer as given via the dashboard only when its parent is the
// running dashboard (the pid in ~/.coordinator/dashboard.json) and it was handed that dashboard's
// token (dashboardCaller). Pure apart from reading the named run's state.
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRun } from './events.mjs';
import { clip } from './plain.mjs';
import { fromForm, OTHER, questions } from './questions.mjs';
import { findEntry } from './registry.mjs';
import { isSafeId } from './store.mjs';

// The variable the dashboard sets for its `run.mjs answer` child: its own token.
export const VIA_ENV = 'COORDINATOR_VIA_DASHBOARD';
// The harness name an answer given on the PC dashboard is stamped with: the person answered in a browser,
// not as the tool that started the dashboard.
export const DASHBOARD_HARNESS = 'dashboard';
// The only variables the detached dashboard and its answer children get from the session that started it:
// enough to find node, the user's folders and temp, and the register. No tokens, no session ids.
const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'COORDINATOR_HOME', 'COORDINATOR_REGISTRY']);
export function childEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (KEEP.has(k.toUpperCase()) && typeof v === 'string') out[k] = v;
  return { ...out, COORDINATOR_HARNESS: DASHBOARD_HARNESS, ...extra };
}
const KEY = /^[0-9a-f]{12}$/;
const QID = /^q[1-9][0-9]{0,4}$/;
const OTHER_MAX = 1000;
const one = (form, name) => { const all = form.getAll(name); return all.length === 1 ? all[0] : null; };

// The registered run and open question a PC dashboard form names, and the `run.mjs answer` arguments
// that record it, or a throw (nothing written). entries: the register, read now (readRegistry).
export function pcAnswer(entries, form, { load = loadRun } = {}) {
  const key = one(form, 'key'); const run = one(form, 'run'); const id = one(form, 'q');
  if (!key || !KEY.test(key) || !run || !isSafeId(run)) throw new Error('that run is not in the register of runs on this PC');
  const e = findEntry(entries, key, run);
  const dir = e ? join(e.stateDir, 'runs', run) : null;
  if (!e || !existsSync(join(dir, 'state.json'))) throw new Error('that run is not in the register of runs on this PC');
  const s = load(dir);
  if (s.closed) throw new Error(`run ${run} is closed`);
  const q = id && QID.test(id) ? questions(s).find((x) => x.id === id) : null;
  if (!q) throw new Error(`no question ${clip(String(id ?? ''), 20)} in run ${run}`);
  if (!q.open) throw new Error(`${id} is not open (${q.status}); answer it in that run's own dashboard or tell the lead`);
  const labels = q.options.map((o) => o.label);
  const choice = form.getAll('choice');
  for (const c of choice) if (c !== OTHER && !labels.includes(c)) throw new Error(`${id} has no option "${clip(c, 60)}"`);
  // A single-select question takes one pick: checked before fromForm, which would keep only the first.
  const picked = choice.filter((c) => c !== OTHER);
  if (!q.multi && (picked.length > 1 || (picked.length && choice.includes(OTHER)))) throw new Error(`${id} takes one answer`);
  const { choices, other } = fromForm(q, choice, form.get('other'));
  const free = typeof other === 'string' && other.trim() ? other : null;
  if (free && free.length > OTHER_MAX) throw new Error(`the answer is ${OTHER_MAX} characters at most`);
  if (!choices.length && !free) throw new Error('give an answer: pick an option or write your own');
  // --name=value: a value that starts with "--" stays a value, never a flag.
  const args = ['answer', run, id, ...choices.map((c) => `--choice=${c}`), ...(free ? [`--other=${free}`] : []), '--by', 'person'];
  return { entry: e, run, id, args, anchor: needsAnchor(key, run) };
}

// The id of one run's block in the front page's Needs you, where the page lands after an answer.
export const needsAnchor = (key, run) => `needs-${key}-${run}`;

// True only in a process the running PC dashboard started: its parent is the pid recorded in
// dashboard.json, and the token it was handed is the one in that record's link.
export function dashboardCaller(token, record, ppid) {
  if (typeof token !== 'string' || !token || !record || !Number.isInteger(record.pid) || record.pid !== ppid) return false;
  let t;
  try { t = new URL(record.url).searchParams.get('t'); } catch { return false; }
  if (typeof t !== 'string') return false;
  const [a, b] = [Buffer.from(t), Buffer.from(token)];
  return a.length === b.length && timingSafeEqual(a, b);
}
