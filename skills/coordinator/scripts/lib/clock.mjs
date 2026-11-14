// The run's clock for the time budget (references/guardrails.md, Budget). Minutes while a
// question to the person is open, from `ask` to its first answer (or the lead's decision that
// closed it), AND no unit of the run is building or judging, do not count: the person deciding
// is not the run working, but a unit at work is. One run waited hours on a question and its
// clock ran out meanwhile (the reins-flight retro). Overlapping questions count once. Pure: lib/rules.mjs (next), lib/plain.mjs (the estimate and ETA) and lib/view.mjs
// (show's time line) all read it, so they agree.
const MINUTE = 60_000;

// The [from, to] spans, in ms, of every question open before atMs, cut at atMs.
function openSpans(run, atMs) {
  const start = Date.parse(run.createdAt);
  const notes = run.notes ?? [];
  const decided = new Map();
  for (const n of notes) if (n?.kind === 'decision' && typeof n.answers === 'string' && !decided.has(n.answers)) decided.set(n.answers, Date.parse(n.at));
  const spans = [];
  let i = 0;
  for (const n of notes) {
    if (n?.kind !== 'question') continue;
    i++;
    const from = Math.max(Date.parse(n.at), start);
    if (!Number.isFinite(from) || from >= atMs) continue;
    const ends = [Date.parse(n.history?.[0]?.at), decided.get(`q${i}`)].filter(Number.isFinite);
    const to = Math.min(atMs, ...ends);
    if (to > from) spans.push([from, to]);
  }
  return spans;
}

// The [from, to] spans, in ms, while a unit was building or judging, cut at atMs: from each
// `start` in its log to the next verdict, ship, reset or start. A span still open ends at atMs
// while the unit is building or judging, else at the last thing its log recorded.
const ENDS = new Set(['verdict', 'ship', 'reset', 'start']);
function busySpans(run, atMs) {
  const spans = [];
  for (const u of run.units ?? []) {
    let from = null;
    const close = (to) => { if (from !== null && Math.min(to, atMs) > from) spans.push([from, Math.min(to, atMs)]); from = null; };
    let last = null;
    for (const e of u?.log ?? []) {
      const t = Date.parse(e?.at);
      if (!Number.isFinite(t)) continue;
      last = t;
      if (ENDS.has(e.kind)) close(t);
      if (e.kind === 'start' && t < atMs) from = t;
    }
    const working = u?.status === 'building' || u?.status === 'judging';
    // A unit at work whose log lost its start: busy since its last heartbeat or the critic's start.
    if (working && from === null) { const t = Date.parse(u.judgingAt ?? u.heartbeatAt); if (Number.isFinite(t) && t < atMs) from = t; }
    close(working ? atMs : (last ?? atMs));
  }
  return spans;
}

// The union of spans, sorted and merged.
function union(spans) {
  const out = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const prev = out.at(-1);
    if (prev && from <= prev[1]) prev[1] = Math.max(prev[1], to); else out.push([from, to]);
  }
  return out;
}

// Minutes up to atMs during which at least one question to the person was open and no unit was
// building or judging.
export function pausedMinutes(run, atMs) {
  const busy = union(busySpans(run, atMs));
  let total = 0;
  for (const [from, to] of union(openSpans(run, atMs))) {
    total += to - from;
    for (const [b0, b1] of busy) total -= Math.max(0, Math.min(to, b1) - Math.max(from, b0));
  }
  return total / MINUTE;
}

// Minutes of the time budget used at atMs: since the run began, less the paused minutes.
export const usedMinutes = (run, atMs) => Math.max(0, (atMs - Date.parse(run.createdAt)) / MINUTE - pausedMinutes(run, atMs));
