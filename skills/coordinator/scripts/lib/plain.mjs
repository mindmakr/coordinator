// Plain words for a run: the situation, what needs the person, a rough time
// left, and one sentence per unit. Pure functions over the state and the plan
// (lib/rules.mjs decide), read by lib/view.mjs.
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

export function situation(run) {
  const note = (run.notes ?? []).filter((n) => n.kind === 'situation').at(-1);
  if (note) return { text: note.text, at: note.at, computed: false };
  const n = run.units.length;
  const count = (st) => run.units.filter((u) => st.includes(u.status)).length;
  const done = count(['pass']); const stopped = count(['stopped']);
  if (!n) return { text: 'No tasks yet.', at: null, computed: true };
  const tail = `${done} done${stopped ? `, ${stopped} stopped` : ''}`;
  if (run.closed) return { text: `Closed as ${run.closed.outcome}: ${tail} of ${n} tasks.`, at: null, computed: true };
  return { text: `${count(IN_PROGRESS)} of ${n} tasks in progress, ${tail}, ${count(['open'])} waiting.`, at: null, computed: true };
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

export function timeLeft(run, plan, nowMs) {
  if (run.closed) return 'None: the run is closed.';
  const left = run.budget.maxMinutes - (nowMs - Date.parse(run.createdAt)) / MINUTE;
  if (left <= 0) return 'None: the time budget is spent.';
  const budget = `the time budget has ${duration(left)} left`;
  const ds = tryMinutes(run);
  if (!ds.length) return `No estimate yet: no try has finished. The time budget has ${duration(left)} left.`;
  const median = ds[Math.floor((ds.length - 1) / 2)];
  // Tries still ahead on the longest chain of unfinished units (units run side by side).
  const open = new Set(plan.units.filter((u) => !['done', 'stopped', 'stop'].includes(u.action)).map((u) => u.id));
  const depth = (id, seen = new Set()) => (seen.has(id) ? 0 : 1 + Math.max(0, ...run.units.filter((u) => u.after === id && open.has(u.id)).map((u) => depth(u.id, new Set([...seen, id])))));
  const roots = run.units.filter((u) => open.has(u.id) && !(u.after && open.has(u.after)));
  const tries = Math.max(0, ...roots.map((u) => depth(u.id))) + (plan.decision === 'integrate' || open.size ? 1 : 0); // + the integration check
  if (!tries) return 'None: nothing is left to run.';
  const est = duration(tries * median);
  return `${est.startsWith('under') ? 'Under a minute' : `About ${est}`} (rough: ${tries} more ${tries === 1 ? 'try' : 'tries'} at a median ${duration(median)} each); ${budget}.`;
}

const failStreak = (rounds) => { let k = 0; for (let i = rounds.length - 1; i >= 0 && rounds[i].verdict === 'fail'; i--) k++; return k; };

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
    case 'done': return 'nothing left to do';
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
