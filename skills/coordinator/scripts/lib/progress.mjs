// Is the run finished, and how near is it? One status word, progress, an ETA and the
// status line, computed here only: `show`, `list`, `status-line`, the HUD and the
// coordinator page all read runStatus, so they never disagree. Pure over the state.
import { decide } from './rules.mjs';
import { questions } from './questions.mjs';
import { gapsModel } from './gaps.mjs';
import { clip, duration, estimate } from './plain.mjs';

const MINUTE = 60_000;
const FINISHING = ['integrate', 'done', 'done-with-gaps', 'stopped'];
export const KINDS = { running: 'Running', waiting: 'Waiting on you', finishing: 'Finishing', concluded: 'Concluded' };
const DELIVERED_SHOWN = 6;

// "21:40", or "Sat 09:10" when it is not today, in this machine's time zone.
export function clock(ms, nowMs, timeZone) {
  const opt = { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) };
  const day = (x) => new Date(x).toLocaleDateString('en-GB', timeZone ? { timeZone } : {});
  const t = new Date(ms).toLocaleTimeString('en-GB', opt);
  return day(ms) === day(nowMs) ? t : `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', ...(timeZone ? { timeZone } : {}) })} ${t}`;
}

// The estimate in plain words: "about 1 h 10 min left; ready around 21:40 local time", or "no estimate yet".
export function eta(run, plan, nowMs, timeZone) {
  const e = estimate(run, plan, nowMs);
  if (e.state === 'closed') return { minutes: 0, readyAt: null, text: 'finished', short: 'finished' };
  if (e.state === 'spent') return { minutes: 0, readyAt: null, text: 'the time budget is spent', short: 'time budget spent' };
  if (e.state !== 'estimate') return { minutes: null, readyAt: null, text: 'no estimate yet', short: 'no estimate yet' };
  // The time budget ends the run first when the estimate runs past it.
  const capped = e.minutes > e.budgetLeft;
  const minutes = Math.round(capped ? e.budgetLeft : e.minutes);
  const readyAt = nowMs + minutes * MINUTE;
  const at = clock(readyAt, nowMs, timeZone);
  const left = minutes < 1 ? 'under a minute left' : `about ${duration(minutes)} left`;
  return {
    minutes, readyAt: new Date(readyAt).toISOString(), capped,
    text: `${left}${capped ? ', when the time budget runs out' : ''}; ready around ${at} local time`,
    short: `${left} (~${at})`,
  };
}

// Why a closed run ended, in one line: the lead's early-close reason, else from the counts.
function closeReason(run, passed, stopped, total) {
  const early = (run.notes ?? []).filter((n) => n.kind === 'decision' && /^closed early as /.test(n.text)).at(-1);
  if (early) return clip(early.text.replace(/^closed early as [a-z]+ at "[^"]*": /, ''), 200);
  const o = run.closed.outcome;
  if (o === 'done') return `the goal is met: ${passed} of ${total} ${total === 1 ? 'unit' : 'units'} passed and the integration check passed`;
  if (o === 'partial') return `${passed} of ${total} units passed${stopped ? `, ${stopped} stopped` : ''}; the rest are follow-ups`;
  return passed ? `${passed} of ${total} units passed before it stopped` : 'no unit passed';
}

const unitName = (u) => (u.title ? `${u.id} ${clip(u.title, 60)}` : u.id);

/**
 * The run's status. plan: decide(run) (computed when missing); runs: the runs its gaps
 * read (the run and the runs it continues or was continued in; every run is fine too).
 */
export function runStatus(run, plan = null, { nowMs = Date.now(), runs = null, timeZone } = {}) {
  // A closed run needs no plan: nothing is left to decide (and a hand-trimmed old state may lack a budget).
  plan ??= run.closed ? { decision: 'closed', units: [] } : decide(run, nowMs);
  const total = run.units.length;
  const passed = run.units.filter((u) => u.status === 'pass').length;
  const stopped = run.units.filter((u) => u.status === 'stopped').length;
  const done = passed + stopped;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const current = run.units.filter((u) => ['building', 'judging'].includes(u.status))
    .map((u) => ({ id: u.id, phase: u.status === 'building' ? 'building' : 'checking', round: u.rounds.length + 1 }));
  const open = run.closed ? [] : questions(run).filter((q) => q.open);
  const asked = new Set(open.map((q) => q.unit).filter(Boolean));
  const finish = run.closed ? [] : plan.units.filter((d) => d.action === 'ask-person' && !asked.has(d.id))
    .map((d) => ({ id: d.id, text: `finish line for ${d.id}: ship with follow-ups, one more round, or stop` }));
  const needsYou = [...open.map((q) => ({ id: q.id, text: clip(q.header || q.text, 140) })), ...finish];
  const kind = run.closed ? 'concluded' : needsYou.length ? 'waiting' : FINISHING.includes(plan.decision) ? 'finishing' : 'running';
  const outcome = run.closed?.outcome ?? null;
  const word = outcome ? `Concluded: ${outcome}` : KINDS[kind];
  const t = eta(run, plan, nowMs, timeZone);
  const doing = current.length ? current.map((c) => `${c.phase} ${c.id} round ${c.round}`).join(', ')
    : kind === 'waiting' ? 'waiting on you'
      : kind === 'finishing' ? (plan.decision === 'integrate' ? 'integration check next' : 'closing next')
        : plan.decision === 'split' ? 'planning units' : 'nothing in progress';
  const g = gapsModel(runs ?? [run]);
  const followUps = g.open.find((x) => x.run === run.id)?.items.length ?? 0;
  const delivered = run.units.filter((u) => u.status === 'pass').map(unitName);
  const st = {
    run: run.id, kind, word, outcome, concluded: !!run.closed, closedAt: run.closed?.at ?? null,
    reason: run.closed ? closeReason(run, passed, stopped, total) : null,
    done, total, passed, stopped, pct, current, doing, eta: t, needsYou, delivered, followUps,
    progress: `${done} of ${total} ${total === 1 ? 'unit' : 'units'} done (${pct}%)${stopped ? `, ${stopped} stopped` : ''}`,
  };
  return { ...st, line: statusLine(st) };
}

const deliveredText = (list) => (list.length ? `${list.slice(0, DELIVERED_SHOWN).join('; ')}${list.length > DELIVERED_SHOWN ? `; and ${list.length - DELIVERED_SHOWN} more` : ''}` : 'nothing');

// The one line a lead posts at each milestone, or the closing line once the run concluded.
export function statusLine(st) {
  if (st.concluded) return `${st.run} concluded: ${st.outcome}. Delivered: ${deliveredText(st.delivered)}. Follow-ups: ${st.followUps} in Gaps. Ready for the next run.`;
  const needs = st.needsYou.length ? `Needs you: ${st.needsYou.map((q) => q.id).join(', ')}.` : 'Nothing needs you.';
  return `${st.run} · ${st.word}: ${st.progress}, ${st.doing}, ${st.eta.short}. ${needs}`;
}

// Runs in the order a person reads them: active first (newest first), then the recently concluded.
export const RECENT_CONCLUDED = 5;
export function ordered(statuses, runs) {
  const at = new Map(runs.map((r) => [r.id, r]));
  const active = statuses.filter((s) => !s.concluded).sort((a, b) => String(at.get(b.run)?.createdAt).localeCompare(String(at.get(a.run)?.createdAt)));
  const ended = statuses.filter((s) => s.concluded).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
  return { active, concluded: ended.slice(0, RECENT_CONCLUDED), older: ended.length - Math.min(ended.length, RECENT_CONCLUDED) };
}

// When the machine frees up: the latest ready time among active runs with an estimate.
export function freeAt(active) {
  const times = active.map((s) => s.eta.readyAt).filter(Boolean).sort();
  return { at: times.at(-1) ?? null, unknown: active.filter((s) => !s.eta.readyAt).length };
}
