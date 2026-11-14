// The run's clock for the time budget (references/guardrails.md, Budget). Minutes while a
// question to the person is open, from `ask` to its first answer (or the lead's decision that
// closed it), do not count: the person deciding is not the run working. One run waited hours on
// a question and its clock ran out meanwhile (the reins-flight retro). Overlapping questions
// count once. Pure: lib/rules.mjs (next), lib/plain.mjs (the estimate and ETA) and lib/view.mjs
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
  return spans.sort((a, b) => a[0] - b[0]);
}

// Minutes up to atMs during which at least one question to the person was open.
export function pausedMinutes(run, atMs) {
  let total = 0; let end = -Infinity;
  for (const [from, to] of openSpans(run, atMs)) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total / MINUTE;
}

// Minutes of the time budget used at atMs: since the run began, less the paused minutes.
export const usedMinutes = (run, atMs) => Math.max(0, (atMs - Date.parse(run.createdAt)) / MINUTE - pausedMinutes(run, atMs));
