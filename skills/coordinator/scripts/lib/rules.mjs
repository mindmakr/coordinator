// The loop's decisions, as pure functions: what each unit should do next, and
// when the loop must stop. No I/O here, so every rule is unit-tested.

import { chainUnits } from './chain.mjs';
import { doubtful, fromPerson } from './approval.mjs';

export const MAX_STRATEGY_CHANGES = 1;
const NO_PROGRESS_ROUNDS = 2;

// Unicode-aware: letters and digits of any script (Arabic, Urdu, CJK, …) count.
export const tokens = (s) => String(s ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const words = (s) => new Set(tokens(s).filter((w) => w.length > 2 || /[^\p{Script=Latin}\p{N}]/u.test(w)));

// Two texts are "the same" when most of their words overlap (Jaccard >= 0.6).
function sameWords(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.6;
}

// A cause tag compares on its words, ignoring case, spacing and punctuation.
export const causeKey = (c) => tokens(c).join(' ');

// Two rounds (or two gap texts) are the same gap when the critic gave both the
// same CAUSE tag. Without a cause on both (older runs, a terse critic) the gap
// wording decides.
export function sameGap(a, b) {
  const A = typeof a === 'object' && a ? a : { gap: a };
  const B = typeof b === 'object' && b ? b : { gap: b };
  if (causeKey(A.cause) && causeKey(B.cause)) return causeKey(A.cause) === causeKey(B.cause);
  return sameWords(A.gap, B.gap);
}

// The run's round budget plus any extra rounds the person approved for this unit (`run.mjs extend`).
export const roundCap = (unit, run) => run.budget.maxRounds + (Number.isInteger(unit.extraRounds) ? unit.extraRounds : 0);

const stop = (reason) => ({ action: 'stop', reason });
const minutes = (from, nowMs) => (nowMs - Date.parse(from)) / 60_000;

// Severity of a finding (the critic's reply, references/briefs.md). Only high and medium fail a round;
// low and nit ride on a pass as fold-ins (`verdict pass --fold`).
export const SEVERITIES = ['high', 'medium', 'low', 'nit'];
export const FAILING = ['high', 'medium'];

// Every finding still open after a round: the general critic's gap and FINDINGS, and every
// specialist's (a failing specialist's gap included). A finding with no severity (an older
// round, a terse critic) counts as high: the finish line never guesses in favour of shipping.
export function openFindings(round) {
  if (!round || round.verdict !== 'fail') return [];
  const one = (by, severity, text) => ({ by, severity: SEVERITIES.includes(severity) ? severity : 'high', text: String(text ?? '') });
  const out = [one('critic', round.severity, round.gap)];
  for (const f of round.findings ?? []) out.push(one('critic', f?.severity, f?.text));
  for (const [name, m] of Object.entries(round.specialists ?? {})) {
    if (m?.verdict === 'fail') out.push(one(name, m.severity, m.gap));
    for (const f of m?.findings ?? []) out.push(one(name, f?.severity, f?.text));
  }
  const seen = new Set();
  return out.filter((f) => f.text && !seen.has(`${f.by}|${f.severity}|${f.text}`) && seen.add(`${f.by}|${f.severity}|${f.text}`));
}

// The ready question for the finish line, and the answers it takes, in the order asked.
export const FINISH = { ship: 'Ship with follow-ups', round: 'One more round', stop: 'Stop' };
export function finishQuestion(unit) {
  const last = unit.rounds.at(-1);
  const open = openFindings(last);
  const list = open.slice(0, 4).map((f) => `${f.severity}: ${f.text.length > 120 ? `${f.text.slice(0, 119)}…` : f.text}`).join('; ');
  return {
    header: 'Finish line',
    question: `${unit.id} is the last unit open (score ${last?.score ?? 'none'}); its latest review left ${open.length} finding${open.length === 1 ? '' : 's'}, none high: ${list}${open.length > 4 ? '; …' : ''}. Ship it with every finding as a follow-up, give it one more round, or stop it?`,
    options: [
      `${FINISH.ship}|merge it as reviewed; every open finding becomes a follow-up`,
      `${FINISH.round}|one more build and review; the same-gap and no-progress rules still apply`,
      `${FINISH.stop}|record it as stopped with its last gap`,
    ],
  };
}

// The finish-line question on this unit asked since its last verdict, with its latest answer
// and whether the lead already acted on it (a decision note that answers it).
function finishAsked(unit, run) {
  const since = unit.rounds.at(-1)?.at ?? '';
  const notes = run.notes ?? [];
  const qs = notes.filter((n) => n.kind === 'question');
  const i = qs.findLastIndex((n) => n.finish === true && n.unit === unit.id && n.at >= since);
  if (i < 0) return null;
  const id = `q${i + 1}`;
  return { id, answer: qs[i].history?.at(-1) ?? null, applied: notes.some((n) => n.kind === 'decision' && n.answers === id) };
}

// When every other unit has passed or stopped, and this one failed from round 2 on (or scored
// 8 or more) with medium findings at most, from the general critic and every specialist, the
// person decides at once (references/commands/run.md, Loop). An answer counts only from the
// person (lib/approval.mjs), and only when their words, if any, carry no doubt ("no, do not ship").
function finishLine(unit, run) {
  const last = unit.rounds.at(-1);
  if (last?.verdict !== 'fail') return null;
  if (unit.rounds.length < 2 && !(typeof last.score === 'number' && last.score >= 8)) return null;
  const open = openFindings(last);
  if (!open.some((f) => f.severity === 'medium') || open.some((f) => f.severity === 'high')) return null;
  if (!run.units.every((x) => x.id === unit.id || ['pass', 'stopped'].includes(x.status))) return null;
  const q = finishAsked(unit, run);
  if (!q) return { action: 'ask-person', question: finishQuestion(unit) };
  if (q.applied) return null; // "one more round" was recorded: the usual rules decide from here
  const a = q.answer;
  if (!a) return { action: 'ask-person', asked: q.id, reason: `waiting for the person's answer to ${q.id}` };
  if (!fromPerson(a) || a.other || a.choices.length !== 1) return { action: 'ask-person', asked: q.id, reason: `${q.id}'s answer is not one option picked by the person` };
  if (a.confirm && doubtful(a.confirm)) return { action: 'ask-person', asked: q.id, reason: `${q.id}'s confirmed words do not clearly say it: "${a.confirm.slice(0, 120)}" (no, not, but, if, maybe or a question); ask again` };
  const pick = a.choices[0];
  if (pick === FINISH.ship) return { action: 'ship', answer: q.id };
  if (pick === FINISH.stop) return stop(`the person chose stop (${q.id})`);
  return { action: 'one-more', answer: q.id };
}

// A critic that started (built recorded) inside the time budget may still return its verdict (#45).
const judgingInTime = (unit, run) => unit.status === 'judging' && typeof unit.judgingAt === 'string'
  && (Date.parse(unit.judgingAt) - Date.parse(run.createdAt)) / 60_000 <= run.budget.maxMinutes;

export function decideUnit(unit, run, nowMs) {
  const { budget } = run;
  if (unit.status === 'pass') {
    // A pass that carries fold-ins waits for their targeted check (`run.mjs foldin`), then merges.
    const last = unit.rounds.at(-1);
    if (last?.folds?.length) return last.foldin ? { action: 'done', step: 'merge' } : { action: 'fold-in', folds: last.folds.length };
    return { action: 'done' };
  }
  if (unit.status === 'stopped') return { action: 'stopped', reason: unit.stopReason };
  // Time first: nothing, including waiting, outlives the run's budget; only a critic already at work may finish.
  if (minutes(run.createdAt, nowMs) > budget.maxMinutes) {
    if (!judgingInTime(unit, run)) return stop('budget: time');
    if (minutes(unit.heartbeatAt ?? unit.judgingAt, nowMs) > budget.staleMinutes) return { action: 'check-stale', phase: 'judging', reason: 'the critic started inside the time budget' };
    return { action: 'judge', reason: 'the critic started inside the time budget' };
  }
  const blocker = unit.after && run.units.find((u) => u.id === unit.after);
  if (blocker?.status === 'stopped') return stop(`blocked: ${unit.after} stopped`);
  if (blocker && blocker.status !== 'pass') return { action: 'wait', reason: `after ${unit.after}` };
  if (unit.status === 'building' || unit.status === 'judging') {
    const since = unit.heartbeatAt ?? run.createdAt;
    if (minutes(since, nowMs) > budget.staleMinutes) return { action: 'check-stale', phase: unit.status };
    return unit.status === 'building' ? { action: 'wait', reason: 'builder running' } : { action: 'judge' };
  }

  const rounds = unit.rounds;
  const last = rounds.at(-1);
  if (!last) return { action: 'build' };
  // The finish line never asks about a unit the rules would stop as stuck or making no
  // progress, and "one more round" does not lift those rules; otherwise the order is as before.
  const prev = rounds.at(-2);
  const same = !!prev && sameGap(prev, last);
  const newStrategy = (unit.strategyAt ?? -1) >= rounds.length;
  const stuck = same && !newStrategy && (unit.strategyChanges ?? 0) >= MAX_STRATEGY_CHANGES;
  const scores = rounds.map((r) => r.score).filter((s) => typeof s === 'number');
  const before = scores.length > NO_PROGRESS_ROUNDS ? Math.max(...scores.slice(0, -NO_PROGRESS_ROUNDS)) : null;
  const flat = !same && before !== null && scores.slice(-NO_PROGRESS_ROUNDS).every((s) => s <= before);
  if (!stuck && !flat) { const finish = finishLine(unit, run); if (finish) return finish; }
  if (rounds.length >= roundCap(unit, run)) return stop('budget: rounds');
  if (same) {
    if (newStrategy) return { action: 'build', reason: 'new strategy recorded', gap: last.gap };
    return stuck ? stop('stuck: same gap after a change of strategy') : { action: 'change-strategy', gap: last.gap };
  }
  if (flat) return stop(noProgress(unit));
  return { action: 'build', gap: last.gap };
}

// The no-progress reason. When one behaviour failed in each of the last rounds
// and every other behaviour marked in the last round passed, the stop names it:
// that is usually an open-ended line ("catch every X"), not worse work (#35).
export function noProgress(unit) {
  const window = unit.rounds.slice(-NO_PROGRESS_ROUNDS);
  const failing = (r) => (r.behaviours ?? []).filter((m) => m.status === 'fail').map((m) => m.id);
  const last = unit.rounds.at(-1)?.behaviours ?? [];
  const lone = failing(unit.rounds.at(-1) ?? {});
  if (lone.length !== 1 || !last.some((m) => m.status === 'pass')) return 'no progress';
  const id = lone[0];
  if (!window.every((r) => failing(r).includes(id))) return 'no progress';
  const words = (unit.behaviours ?? []).find((b) => b.id === id)?.text;
  const quoted = words ? ` ("${words.length > 120 ? `${words.slice(0, 119)}…` : words}")` : '';
  return `no progress: only ${id}${quoted} kept failing while the rest passed; state it as a closed list or a fixed inventory, or move it to its own unit (references/bar.md)`;
}

export function decide(run, nowMs = Date.now()) {
  const units = run.units.map((u) => ({ id: u.id, ...decideUnit(u, run, nowMs) }));
  if (!run.frozen) return { decision: 'split', units };
  const ended = units.length > 0 && units.every((u) => ['done', 'stopped', 'stop'].includes(u.action));
  if (!ended) return { decision: 'continue', units };
  if (!units.some((u) => u.action === 'done')) return { decision: 'stopped', units };
  const integ = run.integration?.rounds ?? [];
  if (integ.at(-1)?.verdict === 'pass') return { decision: 'done', units };
  const repeated = integ.length >= 2 && sameGap(integ.at(-1), integ.at(-2));
  if (integ.length >= run.budget.maxRounds || repeated || minutes(run.createdAt, nowMs) > run.budget.maxMinutes) {
    return { decision: 'done-with-gaps', units };
  }
  return { decision: 'integrate', units };
}

// Which step each command needs; the CLI refuses a step the loop did not ask for.
// A stale builder is restarted (start); a stale critic is re-sent (beat, unit stays judging).
export function allows(cmd, d) {
  if (cmd === 'start') return d.action === 'build' || (d.action === 'check-stale' && d.phase === 'building');
  if (cmd === 'foldin') return d.action === 'fold-in';
  if (cmd === 'strategy') return d.action === 'change-strategy';
  return d.action !== 'stop'; // built, verdict, beat: anything except a unit the rules have stopped
}

// Per-unit rounds-to-pass and stop share across closed runs, for budget tuning.
// Escapes: defects found after a unit passed (`note --kind escape`). The rate is
// escapes per passed unit, the evidence for how deep review has to go.
export function escapes(run) {
  const passed = run.units.filter((u) => u.status === 'pass').length;
  const count = (run.notes ?? []).filter((n) => n.kind === 'escape').length;
  return { escapes: count, passed, rate: passed ? Math.round((count / passed) * 100) / 100 : null };
}

// Escapes and passed units grouped by the critic setup of the verdict that passed
// each unit (`verdict --critic`), so the depth that lets defects through shows up.
export function bySetup(runs) {
  const groups = new Map();
  for (const run of runs) for (const u of run.units) {
    if (u.status !== 'pass') continue;
    const setup = u.rounds.findLast((r) => r.verdict === 'pass')?.critic ?? '(not recorded)';
    const g = groups.get(setup) ?? { setup, passed: 0, escapes: 0 };
    g.passed++;
    g.escapes += (run.notes ?? []).filter((n) => n.kind === 'escape' && n.unit === u.id).length;
    groups.set(setup, g);
  }
  return [...groups.values()].map((g) => ({ ...g, rate: Math.round((g.escapes / g.passed) * 100) / 100 })).sort((a, b) => a.setup.localeCompare(b.setup));
}

// A unit finished in a follow-on run counts once, with its rounds added up (lib/chain.mjs).
export function stats(runs) {
  const passRounds = [];
  let total = 0; let stopped = 0; let unfinished = 0; let shipped = 0;
  for (const u of chainUnits(runs)) {
    total++;
    if (u.unit?.shipped) shipped++; // shipped with follow-ups at the finish line: neither a clean pass nor a stop
    else if (u.status === 'pass') passRounds.push(u.rounds);
    else if (u.status === 'stopped') stopped++;
    else if (u.outcome === 'unfinished') unfinished++; // its run closed with it open: neither a pass nor a stop
  }
  passRounds.sort((a, b) => a - b);
  const pct = (p) => (passRounds.length ? passRounds[Math.min(passRounds.length - 1, Math.ceil(p * passRounds.length) - 1)] : null);
  const p80 = pct(0.8);
  return {
    runs: runs.length, units: total,
    medianRoundsToPass: pct(0.5), p80RoundsToPass: p80,
    stoppedShare: total ? Math.round((stopped / total) * 100) / 100 : null,
    unfinished, unfinishedShare: total ? Math.round((unfinished / total) * 100) / 100 : null,
    shipped, shippedShare: total ? Math.round((shipped / total) * 100) / 100 : null,
    suggestedMaxRounds: p80 === null ? null : Math.min(8, p80 + 1),
    ...escapeTotals(runs),
  };
}

// Behaviours that keep a unit (or the goal) from passing: failing or not yet checked.
export const unmet = (behaviours) => (behaviours ?? []).filter((b) => b.status !== 'pass');

function escapeTotals(runs) {
  const byRun = runs.map((r) => ({ run: r.id, ...escapes(r) }));
  const count = byRun.reduce((n, r) => n + r.escapes, 0);
  const passed = byRun.reduce((n, r) => n + r.passed, 0);
  return { escapes: count, passedUnits: passed, escapeRate: passed ? Math.round((count / passed) * 100) / 100 : null, escapesByRun: byRun.filter((r) => r.escapes), escapesBySetup: bySetup(runs) };
}
