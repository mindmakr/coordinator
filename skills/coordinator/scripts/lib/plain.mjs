// Plain words for a run: the situation, what needs the person, a rough time
// left, and one sentence per unit. Pure functions over the state and the plan
// (lib/rules.mjs decide), read by lib/view.mjs.
import { usedMinutes } from './clock.mjs';

const MINUTE = 60_000;
const IN_PROGRESS = ['building', 'judging'];

export const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

export function duration(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// `plan` and `asks` (lib/rules.mjs decide, lib/questions.mjs) split the units not yet running by who they wait on.
export function situation(run, plan = null, asks = []) {
  const note = (run.notes ?? []).filter((n) => n.kind === 'situation').at(-1);
  if (note) return { text: note.text, at: note.at, computed: false };
  const n = run.units.length;
  const count = (st) => run.units.filter((u) => st.includes(u.status)).length;
  const done = count(['pass']); const stopped = count(['stopped']);
  if (!n) return { text: 'No tasks yet.', at: null, computed: true };
  const tail = `${done} done${stopped ? `, ${stopped} stopped` : ''}`;
  if (run.closed) return { text: `Closed as ${run.closed.outcome}: ${tail} of ${n} tasks.`, at: null, computed: true };
  if (!plan) return { text: `${count(IN_PROGRESS)} of ${n} tasks in progress, ${tail}, ${count(['open'])} waiting.`, at: null, computed: true };
  // With the plan: who the rest wait on, in the dashboard's words.
  const d = new Map(plan.units.map((x) => [x.id, x]));
  const states = run.units.filter((u) => u.status === 'open').map((u) => dotState(u, d.get(u.id), asks));
  const k = (...st) => states.filter((x) => st.includes(x)).length;
  const rest = [[k('needs-you'), 'need you', 'needs you'], [k('blocked'), 'waiting for another unit'], [k('queued'), 'up next'], [k('retrying', 'stale'), 'with the lead']]
    .filter(([c]) => c).map(([c, w, one]) => `${c} ${c === 1 && one ? one : w}`);
  return { text: `${count(IN_PROGRESS)} of ${n} tasks in progress, ${tail}${rest.length ? `, ${rest.join(', ')}` : ''}.`, at: null, computed: true };
}

// Minutes each finished try took: from the unit's previous verdict, or for its
// first try from the run's start (or from when the unit it waits on passed).
export function tryMinutes(run) {
  const passedAt = new Map(run.units.map((u) => [u.id, u.rounds.find((r) => r.verdict === 'pass')?.at]));
  const out = [];
  for (const u of run.units) {
    let from = Date.parse(run.createdAt);
    if (u.after && passedAt.get(u.after)) from = Math.max(from, Date.parse(passedAt.get(u.after)));
    for (const r of u.rounds) {
      const t = Date.parse(r.at);
      if (t > from) out.push((t - from) / MINUTE);
      from = t;
    }
  }
  return out.sort((a, b) => a - b);
}

// The rough estimate behind every "time left": minutes still to run (null before any try
// finished), the time budget left, and the tries counted. lib/progress.mjs words it too.
export function estimate(run, plan, nowMs) {
  if (run.closed) return { state: 'closed' };
  // A state with no time budget (hand-made or trimmed) has no end: the estimate alone counts.
  const max = run.budget?.maxMinutes;
  // Minutes while a question to the person is open do not count (lib/clock.mjs).
  const left = typeof max === 'number' ? max - usedMinutes(run, nowMs) : Infinity;
  if (left <= 0) return { state: 'spent' };
  const ds = tryMinutes(run);
  if (!ds.length) return { state: 'none', budgetLeft: left };
  const median = ds[Math.floor((ds.length - 1) / 2)];
  // Tries still ahead on the longest chain of unfinished units (units run side by side).
  const open = new Set(plan.units.filter((u) => !['done', 'stopped', 'stop'].includes(u.action)).map((u) => u.id));
  const depth = (id, seen = new Set()) => (seen.has(id) ? 0 : 1 + Math.max(0, ...run.units.filter((u) => u.after === id && open.has(u.id)).map((u) => depth(u.id, new Set([...seen, id])))));
  const roots = run.units.filter((u) => open.has(u.id) && !(u.after && open.has(u.after)));
  const tries = Math.max(0, ...roots.map((u) => depth(u.id))) + (plan.decision === 'integrate' || open.size ? 1 : 0); // + the integration check
  if (!tries) return { state: 'nothing', budgetLeft: left };
  return { state: 'estimate', minutes: tries * median, tries, median, budgetLeft: left };
}

export function timeLeft(run, plan, nowMs) {
  const e = estimate(run, plan, nowMs);
  if (e.state === 'closed') return 'None: the run is closed.';
  if (e.state === 'spent') return 'None: the time budget is spent.';
  const budget = Number.isFinite(e.budgetLeft) ? `the time budget has ${duration(e.budgetLeft)} left` : 'no time budget';
  if (e.state === 'none') return `No estimate yet: no try has finished. ${budget[0].toUpperCase()}${budget.slice(1)}.`;
  if (e.state === 'nothing') return 'None: nothing is left to run.';
  const est = duration(e.minutes);
  return `${est.startsWith('under') ? 'Under a minute' : `About ${est}`} (rough: ${e.tries} more ${e.tries === 1 ? 'try' : 'tries'} at a median ${duration(e.median)} each); ${budget}.`;
}

const failStreak = (rounds) => { let k = 0; for (let i = rounds.length - 1; i >= 0 && rounds[i].verdict === 'fail'; i--) k++; return k; };

// The unit's status dot, with the words a screen reader and a tooltip say.
// Each state says who it waits on: only needs-you means the person.
export const DOTS = {
  working: 'working', 'needs-you': 'needs you: only you can unblock it', blocked: 'waiting for another unit', queued: 'up next: ready, not started',
  retrying: 'retrying: the lead is on it', stale: 'quiet: no word from its agent', passed: 'passed', stopped: 'stopped',
};
// The ids a unit waits on (`after`: one id today; a list is read the same way).
export const waitIds = (u) => (Array.isArray(u?.after) ? u.after : u?.after ? [u.after] : []).map(String);
// `asks`: the run's questions; an open one on this unit means it needs the person.
export function dotState(u, d, asks = []) {
  if (u.status === 'pass') return 'passed';
  if (asks.some((q) => q.open && q.unit === u.id)) return 'needs-you';
  if (u.status === 'stopped' || d?.action === 'stop' || d?.action === 'stopped') return 'stopped';
  if (d?.action === 'check-stale') return 'stale';
  if (attention(u, d)) return 'retrying';
  if (['building', 'judging'].includes(u.status)) return 'working';
  if (isBlocked(d)) return 'blocked';
  return 'queued';
}
// The state in words, so colour is never alone. `lead` + `ids` is the label with the ids
// it waits on kept apart, so a page can link each one; `title` says more on hover.
const isBlocked = (d) => d?.action === 'wait' && String(d.reason ?? '').startsWith('after ');
const WORDS = { working: 'Working', passed: 'Passed', stopped: 'Stopped', queued: 'Up next', retrying: 'Retrying', stale: 'Quiet' };
export function stateBadge(state, u, d) {
  const ids = waitIds(u);
  const make = (lead, list = [], title = DOTS[state]) => ({ kind: state, lead, ids: list, label: `${lead}${list.join(', ')}`, title });
  if (state === 'passed' && u?.shipped) return make(shippedLabel(u), [], u.shipped.verdict === 'none' ? 'shipped without a final verdict: the person decided to merge it before a critic judged it; the missing verdict and its open findings are follow-ups' : 'shipped with follow-ups: the person chose to ship it at the finish line; its open findings are follow-ups');
  if (state === 'blocked') return ids.length ? make('Waiting for ', ids) : make('Waiting for another unit');
  if (state === 'needs-you') return isBlocked(d) && ids.length ? make('Needs you · waiting for ', ids) : make('Needs you');
  if (state === 'retrying' || state === 'stale') return make(WORDS[state], [], `The lead is on it: ${attention(u, d) ?? DOTS[state]}`);
  return WORDS[state] ? make(WORDS[state]) : null;
}
// The dot's spoken words: the state, and the ids it waits on in their own case.
export function dotWords(state, b) {
  if (!b?.ids.length) return DOTS[state] ?? state;
  const w = `waiting for ${b.ids.join(', ')}`;
  return state === 'blocked' ? w : `${DOTS[state] ?? state}; ${w}`;
}

// A unit the person shipped at the finish line: never shown as a clean pass.
// A unit merged on their decision before any final verdict (run.mjs ship, #66) says so.
export const shippedLabel = (u) => (u.shipped?.verdict === 'none' ? 'Shipped without a final verdict' : `Shipped with follow-ups (score ${u.shipped?.score ?? u.rounds?.at(-1)?.score ?? 'none'})`);

// The badge's label: the lead is handling it. Only Needs you and question cards address the person.
export const attentionLabel = (reason) => (reason ? (reason.startsWith('no word') ? 'Quiet' : 'Retrying') : null);

export function attention(u, d) {
  if (d?.action === 'check-stale') return 'no word from its agent for a while';
  if (['open', 'building', 'judging'].includes(u.status) && failStreak(u.rounds) >= 2) return `failed ${times(failStreak(u.rounds))} in a row`;
  return null;
}

// What it is for: its title, or the first clause of its bar.
export const purpose = (u) => clip(u.title || String(u.bar ?? '').split(/[;\n]|\.\s/)[0], 110);

function how(u, d) {
  const n = u.rounds.length; const last = u.rounds.at(-1);
  const why = last ? clip(last.cause || last.gap, 70) : '';
  if (u.status === 'pass' && u.shipped?.verdict === 'none') return `shipped without a final verdict on the person's decision${n ? ` after ${n} judged ${n === 1 ? 'try' : 'tries'}` : ''}`;
  if (u.status === 'pass' && u.shipped) return `${shippedLabel(u).toLowerCase()} on try ${n}`;
  if (u.status === 'pass') return `passed on try ${n}`;
  if (u.status === 'stopped') return `stopped after ${n} ${n === 1 ? 'try' : 'tries'}: ${u.stopReason ?? 'stopped'}${why ? ` (last gap: ${why})` : ''}`;
  if (u.status === 'building') return `building, try ${n + 1}`;
  if (u.status === 'judging') return `being checked, try ${n + 1}`;
  if (d?.action === 'wait' && u.after) return `waiting for ${u.after}`;
  if (d?.action === 'stop') return `stopping: ${d.reason}`;
  if (!n) return 'not started';
  const k = failStreak(u.rounds);
  return k ? `failed ${times(k)}${k > 1 ? ' in a row' : ''}: ${why}` : `try ${n} done`;
}

function then(u, d) {
  switch (d?.action) {
    case 'done': return d.step === 'merge' ? 'its fold-ins are checked; next it merges' : 'nothing left to do';
    case 'fold-in': return 'next a quick check of its fold-ins, then it merges';
    case 'ask-person': return d.reason?.startsWith('same-files') ? 'next the person decides: change the bar, simplify the design, accept it as is, or one more round' : 'next the person decides: ship, one more round, or stop';
    case 'stopped': case 'stop': return 'it goes in the report as stopped';
    case 'judge': return 'next a critic checks it';
    case 'check-stale': return 'next the lead checks on the silent agent';
    case 'change-strategy': return 'next a different approach, then another try';
    case 'build': return u.rounds.length ? 'next another try' : 'next the first build';
    case 'wait': return u.after && d.reason?.startsWith('after') ? 'starts when it passes' : 'next a critic checks it when the builder finishes';
    default: return '';
  }
}

export function sentence(u, d) {
  const h = how(u, d); const t = then(u, d); const p = purpose(u);
  return `${p}${/[.…!?]$/.test(p) ? '' : '.'} ${h[0].toUpperCase()}${h.slice(1)}${t ? `; ${t}` : ''}.`;
}
