// What happened, in time order: the run's timeline and each unit's own.
// Events come from the state (rounds, notes, answers, and the unit's log of
// start, beats, built, strategy, evidence, links and stops). `matches` is also
// the page's filter: the served page runs this same function's source.
import { answerText, questions } from './questions.mjs';

const LOG_MAX = 200;

// Appends to a unit's own log; beats are dropped first when it is full.
export function log(unit, kind, text = '', extra = {}) {
  const list = (unit.log ??= []);
  list.push({ kind, text, at: new Date().toISOString(), ...extra });
  while (list.length > LOG_MAX) { const i = list.findIndex((e) => e.kind === 'beat'); list.splice(i < 0 ? 0 : i, 1); }
}

// The colour family behind each badge; the badge always shows its label too.
export const BADGES = ['decision', 'question', 'answer', 'note', 'pass', 'fail', 'stop', 'merge', 'evidence', 'strategy', 'behaviour', 'build', 'link', 'info'];
const NOTE_BADGE = { decision: 'decision', question: 'question', person: 'note', strategy: 'strategy' };
const LOG_BADGE = { start: 'build', beat: 'build', built: 'build', reset: 'build', strategy: 'strategy', evidence: 'evidence', stop: 'stop', behaviour: 'behaviour' };

const ev = (at, badge, label, unit, rest = {}) => ({ at, badge, label, unit: unit ?? null, who: '', score: null, cause: null, text: '', ...rest });
const roundEv = (r, unit, who) => ev(r.at, r.verdict, `verdict ${r.verdict}`, unit, { who, score: r.score ?? null, cause: r.cause ?? null, text: r.verdict === 'pass' ? (r.evidence ?? '') : (r.gap ?? '') });
// An evidence entry names its item first ("E41 screenshot: …"); `ev` points at the stored item so the page can open it.
function evRef(e, u) {
  const id = e.kind === 'evidence' ? /^E\d+(?![\w-])/.exec(e.text ?? '')?.[0] : null;
  const it = id && (u.evidence ?? []).find((x) => x.id === id);
  return it ? { ev: { target: u.id, id, kind: it.kind ?? null, label: it.label ?? null, file: it.file ?? null, type: it.type ?? null, inline: typeof it.text === 'string' } } : {};
}
const logEv = (e, u) => ev(e.at, e.kind === 'link' ? (e.link === 'merge' ? 'merge' : 'link') : (LOG_BADGE[e.kind] ?? 'info'), e.kind === 'link' ? (e.link ?? 'link') : e.kind, u.id, { who: u.id, text: e.text ?? '', ...evRef(e, u) });
const byTime = (a, b) => a.at.localeCompare(b.at);

function noteEvents(run, keep) {
  const notes = (run.notes ?? []).filter((n) => n.kind !== 'question' && keep(n));
  const qs = questions(run).filter(keep);
  return [
    ...notes.map((n) => ev(n.at, NOTE_BADGE[n.kind] ?? 'info', n.kind, n.unit, { who: n.unit ?? '', text: n.answers ? `${n.answers} answered: ${n.text}` : n.text })),
    ...qs.map((q) => ev(q.at, 'question', 'question', q.unit, { who: q.id, text: q.text })),
    ...qs.flatMap((q) => q.history.map((a) => ev(a.at, 'answer', 'answer', q.unit, { who: a.by, text: `${q.id} answered: ${answerText(a)}` }))),
  ];
}

// Each try's start and end stamps, from the unit's log (start, built, reset) and its rounds (the verdict
// ends a try): { n, start, built, end, minutes, build, review, open }. Minutes are wall-clock time while an
// agent worked on the try: start to the verdict, less the gap after a reset (a crashed build) until the next
// start. review is the last built to the verdict, build the rest (a crashed build counts as build time), so
// build + review = minutes. A try with a start stamp has minutes, 0 when its stamps are the same instant; one
// whose start fell out of the log has null. The try in progress (building or judging) runs to nowMs, open: true.
export function tryTimes(u, nowMs) {
  const log = (u.log ?? []).filter((e) => e && typeof e.at === 'string' && ['start', 'built', 'reset'].includes(e.kind));
  const mins = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) / 60_000 : null);
  const one = (n, lo, end, open) => {
    let from = null; let start = null; let built = null; let worked = 0;
    for (const e of log.filter((x) => x.at > lo && (!end || x.at <= end))) {
      if (e.kind === 'start') { start ??= e.at; from ??= e.at; }
      else if (e.kind === 'built') built = e.at;
      else if (from) { worked += mins(from, e.at); from = null; built = null; } // reset: the build ended with no verdict
    }
    const to = end ?? new Date(nowMs).toISOString();
    if (from) worked += mins(from, to);
    const review = built ? mins(built, to) : null;
    return { n, start, built, end, open, minutes: start === null ? null : worked, build: review === null ? null : Math.max(0, worked - review), review };
  };
  const out = []; let lo = '';
  for (const [i, r] of (u.rounds ?? []).entries()) { if (typeof r.at !== 'string') continue; out.push(one(r.n ?? i + 1, lo, r.at, false)); lo = r.at; }
  if (['building', 'judging'].includes(u.status)) { const t = one((u.rounds?.length ?? 0) + 1, lo, null, true); if (t.start) out.push(t); }
  return out;
}

// A unit's working time over its tries: total, build and review minutes of the stamped tries, how many
// tries had no start stamp, and whether one is still running. minutes is null when no try was stamped.
export function workTime(tries) {
  const known = tries.filter((t) => t.minutes !== null);
  const sum = (k) => known.reduce((n, t) => n + (t[k] ?? 0), 0);
  return { minutes: known.length ? sum('minutes') : null, build: sum('build'), review: sum('review'), unstamped: tries.length - known.length, open: tries.some((t) => t.open) };
}

// Every event of one unit, oldest first.
export function unitTimeline(run, id) {
  const u = run.units.find((x) => x.id === id);
  if (!u) return [];
  return [
    ...(u.log ?? []).map((e) => logEv(e, u)),
    ...u.rounds.map((r) => roundEv(r, id, `r${r.n}`)),
    ...noteEvents(run, (n) => n.unit === id),
  ].filter((e) => e.at).sort(byTime);
}

// The run's events, oldest first: unit logs (strategy shows once, as its note), rounds, integration, notes, answers.
export function runTimeline(run) {
  const integ = run.integration?.rounds ?? [];
  return [
    ...run.units.flatMap((u) => (u.log ?? []).filter((e) => e.kind !== 'strategy').map((e) => logEv(e, u))),
    ...run.units.flatMap((u) => u.rounds.map((r) => roundEv(r, u.id, `${u.id} r${r.n}`))),
    ...integ.map((r, i) => roundEv(r, null, `integration r${i + 1}`)),
    ...noteEvents(run, () => true),
  ].filter((e) => e.at).sort(byTime);
}

export const RANGES = [['all', 'All'], ['30m', 'Last 30 min'], ['120m', 'Last 120 min'], ['4h', 'Last 4 h'], ['8h', 'Last 8 h'], ['24h', 'Last 24 h'], ['2-7d', '2–7 days ago'], ['8d', '8+ days ago']];

// Self-contained (the page runs its source): does an event pass the filter?
// f: { q, kinds: [], units: [], range }. "2–7 days ago" is older than 24 h up to 7 days; "8+ days" is older.
export function matches(e, f, nowMs) {
  const age = (nowMs - Date.parse(e.at)) / 60000;
  const win = { '30m': [0, 30], '120m': [0, 120], '4h': [0, 240], '8h': [0, 480], '24h': [0, 1440], '2-7d': [1440, 10080], '8d': [10080, Infinity] }[f.range];
  if (win && !(age > (win[0] || -Infinity) && age <= win[1])) return false; // a clock a little ahead still counts as recent
  if (f.kinds && f.kinds.length && !f.kinds.includes(e.badge)) return false;
  if (f.units && f.units.length && !f.units.includes(e.unit || '')) return false;
  const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); // case, accents and diacritics
  const q = fold(String(f.q || '').trim());
  return !q || fold(`${e.label} ${e.who} ${e.text} ${e.cause || ''}`).includes(q);
}

export function filter(events, f, nowMs) {
  const out = events.filter((e) => matches(e, f, nowMs));
  return f.sort === 'oldest' ? out.sort(byTime) : out.sort((a, b) => byTime(b, a));
}
