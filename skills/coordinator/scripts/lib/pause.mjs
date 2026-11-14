// A run paused by hand (run.mjs pause / resume, #132): the person stops the work, overnight or
// while the PC restarts. Paused minutes count toward no budget (lib/clock.mjs), and while the run
// is paused no unit is started (lib/rules.mjs). Each pause is { from, to, reason } in run.pauses;
// `to` is missing while it lasts. Pure: the CLI records what these return.

// The pause that lasts now, or null.
export function openPause(run) {
  const p = Array.isArray(run?.pauses) ? run.pauses.at(-1) : null;
  return p && typeof p === 'object' && !p.to ? p : null;
}

const since = (p) => `since ${p.from}${p.reason ? ` (${p.reason})` : ''}`;
export const resumeStep = (run) => `run.mjs resume ${run.id}`;

// Why a command that starts work is refused on a paused run, or null when it is not paused.
export function pausedRefusal(run, cmd) {
  const p = openPause(run);
  return p ? `${cmd} refused: run ${run.id} is paused ${since(p)}; ${resumeStep(run)} first` : null;
}

// Starts a pause at `at`; refused while one lasts.
export function pauseRun(run, { reason, at }) {
  const p = openPause(run);
  if (p) throw new Error(`pause refused: run ${run.id} is already paused ${since(p)}; ${resumeStep(run)} to go on`);
  run.pauses = [...(Array.isArray(run.pauses) ? run.pauses : []), { from: at, reason }];
  return run;
}

// Ends the pause that lasts; refused on a run that is not paused.
export function resumeRun(run, { at }) {
  const p = openPause(run);
  if (!p) throw new Error(`resume refused: run ${run.id} is not paused`);
  p.to = at;
  return run;
}

// What `next` says about a paused run: since when, why, and the command that resumes it.
export function pauseNote(run) {
  const p = openPause(run);
  return p ? { since: p.from, reason: p.reason ?? null, step: `${resumeStep(run)} when the person says to go on` } : null;
}

// The actions that start or restart an agent; on a paused run they wait instead.
const STARTS = ['build', 'judge', 'fold-in', 'change-strategy', 'check-stale'];
export function held(run, d) {
  if (!STARTS.includes(d.action) || !openPause(run)) return d;
  return { action: 'wait', reason: `run paused: ${resumeStep(run)}`, paused: true, was: d.action };
}
