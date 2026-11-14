// The loop's decisions, as pure functions: what each unit should do next, and
// when the loop must stop. No I/O here, so every rule is unit-tested.

import { chainUnits } from './chain.mjs';
import { doubtful, fromPerson } from './approval.mjs';
import { strategyHint } from './strategy.mjs';
import { usedMinutes } from './clock.mjs';

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

// The specialists required on round n (1-based). One added later (`run.mjs add-specialist`) is
// required from the next build on, never on a round that closed before it was added (#45).
export const requiredOn = (unit, n) => (unit.specialists ?? []).filter((name) => (unit.specialistFrom?.[name] ?? 1) <= n);

// Early reviews (`verdict --early`, #66): a critic's look at work started before the unit's try did (a stacked
// unit begun early). Never a round: no rule here reads them. These are the ones since the last formal round.
export const earlyReviews = (unit) => (Array.isArray(unit.early) ? unit.early : []).filter((r) => r?.before === unit.rounds.length + 1);
// "2 early reviews (security pass 9.3; critic fail 6)": how `next` and the pages name them.
export function earlySummary(unit) {
  const list = earlyReviews(unit);
  if (!list.length) return null;
  return { count: list.length, text: `${list.length} early review${list.length === 1 ? '' : 's'}, not rounds (${list.map((r) => `${r.by} ${r.verdict}${typeof r.score === 'number' ? ` ${r.score}` : ''}`).join('; ')})` };
}

const stop = (reason) => ({ action: 'stop', reason });
const minutes = (from, nowMs) => (nowMs - Date.parse(from)) / 60_000;
// The time budget's clock: paused while a question to the person is open and no unit is building or judging (lib/clock.mjs).
const spent = (run, nowMs) => usedMinutes(run, nowMs) > run.budget.maxMinutes;

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

// The ready question (the finish line, or same files) on this unit asked since its last verdict, with
// its kind, its latest answer and whether the lead already acted on it (a decision note that answers it).
// One per verdict: once either is asked, the other waits for the next verdict.
function readyAsked(unit, run) {
  const since = unit.rounds.at(-1)?.at ?? '';
  const notes = run.notes ?? [];
  const qs = notes.filter((n) => n.kind === 'question');
  const i = qs.findLastIndex((n) => (n.finish === true || Array.isArray(n.sameFiles)) && n.unit === unit.id && n.at >= since);
  if (i < 0) return null;
  const id = `q${i + 1}`;
  return { id, kind: qs[i].finish === true ? 'finish' : 'same-files', answer: qs[i].history?.at(-1) ?? null, applied: notes.some((n) => n.kind === 'decision' && n.answers === id) };
}

// Why the person's answer to a ready question does not count yet, as an ask-person step; null when it does.
function unclearAnswer(q, prefix = '') {
  const a = q.answer;
  if (!a) return { action: 'ask-person', asked: q.id, reason: `${prefix}waiting for the person's answer to ${q.id}` };
  if (!fromPerson(a) || a.other || a.choices.length !== 1) return { action: 'ask-person', asked: q.id, reason: `${prefix}${q.id}'s answer is not one option picked by the person` };
  if (a.confirm && doubtful(a.confirm)) return { action: 'ask-person', asked: q.id, reason: `${prefix}${q.id}'s confirmed words do not clearly say it: "${a.confirm.slice(0, 120)}" (no, not, but, if, maybe or a question); ask again` };
  return null;
}

// The file a finding names, from its first word: "src/a.ts:12 …" (references/briefs.md, FINDINGS:
// <severity> <file:line> <what>). Quotes, backticks, a line or range (":12", ":12-30", "#L12") and
// a leading "./" go; backslashes become slashes. Null when the first word is not a path.
export function findingFile(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? '';
  const word = first.replace(/^[`'"(\[]+/, '').replace(/[`'")\],;.]+$/, '').replace(/\\/g, '/');
  const file = word.replace(/(?:#L\d+\S*|:\d+(?:[-–:,]\d+)*:?)$/, '').replace(/^\.\//, '');
  // A path has a folder, or a name and an extension ("a.ts"); "Totals." or "e.g." is a word.
  if (/^[a-z]+:\/\//i.test(file) || !/^(?:[^/]*[\p{L}\p{N}][^/]*\/.*[\p{L}\p{N}]|[^/]{2,}\.\p{L}[\p{L}\p{N}]{0,7})$/u.test(file)) return null;
  return file;
}

// Two finding paths name the same file when they are equal or one ends with the other at a
// folder boundary: "flight.ts:104" and "packages/reins/src/flight.ts:385" (critics cite either).
export const sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

// The files a failing round's high and medium findings name, from the general critic and every specialist.
const failingFiles = (round) => new Set(openFindings(round).filter((f) => FAILING.includes(f.severity)).map((f) => findingFile(f.text)).filter(Boolean));

// The ready question when two failing rounds kept hitting the same files, and the answers it takes.
export const SAME_FILES = { bar: 'Change the bar', simplify: 'Simplify the design', accept: 'Accept as is', round: 'One more round' };
export function sameFilesQuestion(unit, files) {
  const fails = unit.rounds.filter((r) => r.verdict === 'fail').slice(-2);
  const where = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
  return {
    header: 'Same files',
    question: `${unit.id} failed review twice in a row (scores ${fails.map((r) => r.score ?? 'none').join(' then ')}), and both times the serious problems were in the same place: ${where}. Each fix moved the problem instead of closing it, which often means the target cannot be met as written, not that the code is careless. Change what this unit must meet, simplify its design, accept it as it is, or try one more round?`,
    options: [
      `${SAME_FILES.bar}|rewrite what this unit must meet so it can be met, then build again`,
      `${SAME_FILES.simplify}|build a simpler approach to the same goal, then review again`,
      `${SAME_FILES.accept}|ship it as reviewed; every open finding becomes a follow-up`,
      `${SAME_FILES.round}|one more build and review as it is; the usual stop rules still apply`,
    ],
  };
}

// When a unit's two most recent failing rounds both have high or medium findings in a common file,
// the person decides, whatever the cause tags say (the reins-flight retro: five rounds in the same
// few hundred lines, a new cause tag each round, so the same-gap rule never fired). Their pick:
// "Accept as is" ships with follow-ups; any other is one more round, recorded like extend.
function sameFilesLine(unit, run) {
  const fails = unit.rounds.filter((r) => r.verdict === 'fail').slice(-2);
  if (fails.length < 2 || unit.rounds.at(-1) !== fails[1]) return null;
  const later = [...failingFiles(fails[1])];
  // A file both rounds name, by its longer (more exact) path.
  const files = [...new Set([...failingFiles(fails[0])].flatMap((a) => later.filter((b) => sameFile(a, b)).map((b) => (b.length >= a.length ? b : a))))].sort();
  if (!files.length) return null;
  const reason = `same-files: ${files.join(', ')}`;
  const q = readyAsked(unit, run);
  if (!q) return { action: 'ask-person', reason, files, question: sameFilesQuestion(unit, files) };
  if (q.kind !== 'same-files' || q.applied) return null; // the finish line was asked first, or the pick was recorded
  const unclear = unclearAnswer(q, `${reason}; `);
  if (unclear) return { ...unclear, files };
  const pick = q.answer.choices[0];
  if (pick === SAME_FILES.accept) return { action: 'ship', answer: q.id, at: 'the same-files question' };
  return { action: 'one-more', answer: q.id, choice: pick, at: 'the same-files question' };
}

// No progress, like with like: each critic (the general one and every specialist) is compared
// with its own earlier scores. It is no progress when a critic with more than NO_PROGRESS_ROUNDS
// scores has not beaten its own earlier best in its last NO_PROGRESS_ROUNDS: one critic rising
// while another stays flat is not progress. A critic with no earlier score (a specialist that
// joined later) is not compared yet, and a specialist that last scored before the last
// NO_PROGRESS_ROUNDS rounds no longer counts.
export function flatCritic(rounds) {
  const series = new Map(); // null: the general critic
  rounds.forEach((r, i) => {
    const add = (name, s) => { if (typeof s === 'number') { if (!series.has(name)) series.set(name, []); series.get(name).push({ i, s }); } };
    add(null, r?.score);
    for (const [name, m] of Object.entries(r?.specialists ?? {})) add(name, m?.score);
  });
  for (const [name, list] of series) {
    if (list.length <= NO_PROGRESS_ROUNDS) continue;
    if (name !== null && list.at(-1).i < rounds.length - NO_PROGRESS_ROUNDS) continue;
    const before = Math.max(...list.slice(0, -NO_PROGRESS_ROUNDS).map((x) => x.s));
    if (list.slice(-NO_PROGRESS_ROUNDS).every((x) => x.s <= before)) return name ?? 'general';
  }
  return null;
}

// When every other unit has passed or stopped, and this one failed from round 2 on (or scored
// 8 or more) with medium findings at most, from the general critic and every specialist, the
// person decides at once (references/commands/run.md, Loop). An answer counts only from the
// person (lib/approval.mjs), and only when their words, if any, carry no doubt ("no, do not ship").
function finishLine(unit, run) {
  const last = unit.rounds.at(-1);
  if (last?.verdict !== 'fail') return null;
  if (unit.rounds.length < 2 && !(typeof last.score === 'number' && last.score >= 8)) return null;
  // Every required specialist must have marked this round first: a mark still to come may be a high.
  if (requiredOn(unit, unit.rounds.length).some((n) => !last.specialists?.[n])) return null;
  const open = openFindings(last);
  if (!open.some((f) => f.severity === 'medium') || open.some((f) => f.severity === 'high')) return null;
  if (!run.units.every((x) => x.id === unit.id || ['pass', 'stopped'].includes(x.status))) return null;
  const q = readyAsked(unit, run);
  if (!q) return { action: 'ask-person', question: finishQuestion(unit) };
  if (q.kind !== 'finish') return null; // the same-files question was asked for this verdict
  if (q.applied) return null; // "one more round" was recorded: the usual rules decide from here
  const unclear = unclearAnswer(q);
  if (unclear) return unclear;
  const pick = q.answer.choices[0];
  if (pick === FINISH.ship) return { action: 'ship', answer: q.id };
  if (pick === FINISH.stop) return stop(`the person chose stop (${q.id})`);
  return { action: 'one-more', answer: q.id };
}

// A critic that started (built recorded) inside the time budget may still return its verdict (#45).
const judgingInTime = (unit, run) => unit.status === 'judging' && typeof unit.judgingAt === 'string'
  && usedMinutes(run, Date.parse(unit.judgingAt)) <= run.budget.maxMinutes;

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
  if (spent(run, nowMs)) {
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
  // After a general fail, wait for every required specialist to mark that round: a new build would
  // close it, and a finding still to come would be lost. Only rounds with a severity (this version
  // on), so older runs never wait on marks that could not be recorded then. `start --force-start` skips it.
  const unmarked = last.verdict === 'fail' && last.severity ? requiredOn(unit, rounds.length).filter((n) => !last.specialists?.[n]) : [];
  if (unmarked.length) return { action: 'wait', reason: `waiting for specialist marks: ${unmarked.join(', ')}`, specialists: unmarked };
  // The finish line never asks about a unit the rules would stop as stuck or making no
  // progress, and "one more round" does not lift those rules; otherwise the order is as before.
  const prev = rounds.at(-2);
  const same = !!prev && sameGap(prev, last);
  const newStrategy = (unit.strategyAt ?? -1) >= rounds.length;
  const stuck = same && !newStrategy && (unit.strategyChanges ?? 0) >= MAX_STRATEGY_CHANGES;
  const flat = !same && flatCritic(rounds) !== null;
  if (!stuck && !flat) { const ask = sameFilesLine(unit, run) ?? finishLine(unit, run); if (ask) return ask; }
  if (rounds.length >= roundCap(unit, run)) return stop('budget: rounds');
  if (same) {
    if (newStrategy) return { action: 'build', reason: 'new strategy recorded', gap: last.gap };
    return stuck ? stop('stuck: same gap after a change of strategy') : { action: 'change-strategy', gap: last.gap, ...strategyHint(prev, last) };
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

// The time budget stops new builds and critics, not work already under way (#45). When a critic
// started inside the budget passed the run's last open unit after it ran out, the integration check
// of that work may still be logged: once, so a failed one ends the run as before. A run whose budget
// stopped any other unit ends with gaps: the late pass was not the last of its work.
function lateIntegration(run, units) {
  if (units.some((u) => u.reason === 'budget: time')) return false;
  const after = (r) => usedMinutes(run, Date.parse(r?.at)) > run.budget.maxMinutes;
  const latePass = run.units.some((u) => u.status === 'pass' && after(u.rounds.at(-1)));
  return latePass && !(run.integration?.rounds ?? []).some(after);
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
  if (integ.length >= run.budget.maxRounds || repeated || (spent(run, nowMs) && !lateIntegration(run, units))) {
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
  const passed = run.units.filter((u) => u.status === 'pass' && !u.shipped).length; // shipped units are counted apart
  const count = (run.notes ?? []).filter((n) => n.kind === 'escape').length;
  return { escapes: count, passed, rate: passed ? Math.round((count / passed) * 100) / 100 : null };
}

// Escapes and passed units grouped by the critic setup of the verdict that passed
// each unit (`verdict --critic`), so the depth that lets defects through shows up.
export function bySetup(runs) {
  const groups = new Map();
  for (const run of runs) for (const u of run.units) {
    if (u.status !== 'pass' || u.shipped) continue; // shipped units are counted apart
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
