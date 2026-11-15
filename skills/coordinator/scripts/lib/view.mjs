// What a person sees of a run at a glance, computed once from the state. The
// text view (`run.mjs show`) and hud.html both read this model, so they agree.
import { origin } from './harness.mjs';
import { byModel, modelLine, unrecorded, UNSPECIFIED, whoUnit } from './models.mjs';
import { attention, attentionLabel, clip, dotState, sentence, situation, stateBadge, timeLeft, waitIds } from './plain.mjs';
import { answerText, questions } from './questions.mjs';
import { chainLine, chainOf } from './chain.mjs';
import { overlapsOf, pendingSyncs, syncStep } from './overlap.mjs';
import { bySetup, criticSetups, earlySummary, escapes, roundCap, unmet } from './rules.mjs';
import { runTimeline, tryTimes, unitTimeline, workTime } from './timeline.mjs';
import { retroPending } from './retro.mjs';
import { costByKind, costByModel, costLine, runCost, unitCost } from './cost.mjs';
import { agoText, runStatus } from './progress.mjs';
import { leadInfo } from './lead.mjs';
import { pauseParts, usedMinutes } from './clock.mjs';
import { openPause, resumeStep } from './pause.mjs';

const ACTIVE = ['build', 'judge', 'change-strategy', 'check-stale', 'fold-in', 'ask-person'];

const label = (d) => (d ? `${d.action}${d.reason ? `: ${d.reason}` : ''}${d.phase ? ` (${d.phase})` : ''}` : '');

// The time line's note: the minutes that did not count, and why.
function pausedNote(run, end) {
  const p = pauseParts(run, end);
  const parts = [
    ...(Math.round(p.held) ? [`${Math.round(p.held)} min on pause`] : []),
    ...(Math.round(p.asked) ? [`${Math.round(p.asked)} min paused while the person decided and no unit was at work`] : []),
  ];
  return parts.length ? { note: parts.join(', ') } : {};
}

function nextStep(run, plan) {
  if (run.closed) return `nothing: closed as ${run.closed.outcome}`;
  if (openPause(run)) return `paused: ${resumeStep(run)} when the person says to go on`;
  switch (plan.decision) {
    case 'split': return 'add units, then freeze';
    case 'integrate': return 'send the integrator';
    case 'done': return 'retro, then close --outcome done';
    case 'done-with-gaps': return 'retro, then close --outcome partial';
    case 'stopped': return 'retro, then close --outcome stopped';
    default: {
      const steps = plan.units.filter((u) => ACTIVE.includes(u.action)).map((u) => `${u.action} ${u.id}`);
      return steps.length ? steps.join(' · ') : 'wait for the running agents';
    }
  }
}

// linked: the runs this one continues or was continued in (lib/chain.mjs linkedRuns); without them a chain still shows, its other runs as "not here".
// The evidence that goes with a round's gap. A round the general critic passed and a specialist failed (#126)
// carries the specialist's gap but the general critic's evidence; its evidence is the specialist's own (#147),
// each one named when several failed it, as the gap names each one's gap (lib/rules.mjs specialistFailure).
export function gapEvidence(r) {
  if (!r) return null;
  if (!r.failedBy?.length) return r.evidence ?? null;
  const by = r.failedBy.map((n) => [n, r.specialists?.[n]?.evidence]).filter(([, e]) => e);
  return by.length ? (r.failedBy.length === 1 ? by[0][1] : by.map(([n, e]) => `${n}: ${e}`).join('; ')) : null;
}

// project: the project's name for each question's label (lib/questions.mjs questionLabel); the hosted service passes the repo's name.
export function view(run, plan, nowMs = Date.now(), { repo = null, linked = null, project = null, alive = null, timeZone } = {}) {
  const end = run.closed ? Date.parse(run.closed.at) : nowMs;
  const next = new Map(plan.units.map((u) => [u.id, u]));
  const integ = run.integration?.rounds ?? [];
  const notes = run.notes ?? [];
  const pick = (kind) => notes.filter((n) => n.kind === kind).map((n) => n.text);
  const qs = questions(run, { project });
  const personNotes = notes.filter((n) => n.kind === 'person').map((n) => ({ text: n.text, unit: n.unit ?? null, at: n.at }));
  const timeline = runTimeline(run).reverse();
  const goalBehaviours = run.goalBehaviours ?? [];
  const syncs = run.closed ? new Map() : pendingSyncs(run);
  // Each unit's state, and which units wait on which (for the links both ways).
  const dots = new Map(run.units.map((u) => [u.id, dotState(u, next.get(u.id), run.closed ? [] : qs)]));
  const brief = (id) => { const x = run.units.find((y) => y.id === id); const st = dots.get(id); return { id, title: x?.title ?? null, status: x?.status ?? null, dot: st ?? null, badge: x ? stateBadge(st, x, next.get(id)) : null }; };
  return {
    id: run.id, tag: run.tag, goal: run.goal, repo: run.repo ?? repo, project, origin: origin(run),
    continues: Array.isArray(run.continues) ? run.continues : [],
    goalCheck: {
      behaviours: goalBehaviours, evidence: run.goalEvidence ?? [],
      met: goalBehaviours.length ? !unmet(goalBehaviours).length : (run.closed?.outcome ?? plan.decision) === 'done',
    }, bar: run.bar, fence: run.fence,
    phase: run.closed ? `closed: ${run.closed.outcome}` : openPause(run) ? 'paused' : plan.decision,
    // The plain status word, progress and ETA (lib/progress.mjs), the same everywhere.
    status: runStatus(run, plan, { nowMs, runs: linked ? [...linked.values()].filter((r) => r && Array.isArray(r.units)) : [run] }),
    retroPending: retroPending(run, plan.decision), // every unit decided and no retro note yet (lib/retro.mjs)
    open: !run.closed, started: run.createdAt, closedAt: run.closed?.at ?? null,
    // Ages worked out here, in minutes and this machine's local time (lib/lead.mjs, lib/progress.mjs agoText).
    startedText: agoText(run.createdAt, nowMs, timeZone), lead: run.closed ? null : leadInfo(run, nowMs, { alive, timeZone }),
    situation: situation(run, plan, run.closed ? [] : qs),
    needsYou: run.closed ? [] : qs.filter((q) => q.open),
    answered: run.closed ? [] : qs.filter((q) => q.status === 'answered'),
    asks: qs, personNotes,
    timeLeft: timeLeft(run, plan, nowMs),
    budget: [
      // Minutes paused by hand, or while a question to the person is open and no unit is at work, do not count (lib/clock.mjs).
      { name: 'time', used: Math.round(usedMinutes(run, end)), max: run.budget.maxMinutes, unit: 'min', ...pausedNote(run, end) },
      { name: 'units', used: run.units.length, max: run.budget.maxUnits, unit: '' },
      { name: 'added after freeze', used: run.addedAfterFreeze ?? 0, max: run.budget.maxAdded, unit: '' },
      { name: 'integration rounds', used: integ.length, max: run.budget.maxRounds, unit: '' },
    ],
    // Rounds and pass rate per builder model, once any round recorded one (lib/models.mjs).
    models: byModel([run]).roundsByBuilderModel.filter((m) => !['(not recorded)', UNSPECIFIED].includes(m.model)),
    modelsUnrecorded: unrecorded(run),
    // Tokens, minutes and money the lead recorded per launch (lib/cost.mjs); "not recorded" where none was.
    cost: {
      run: costLine(runCost(run)), byModel: costByModel([run]).map((m) => ({ model: m.model, line: costLine(m) })), byUnit: run.units.map((u) => ({ id: u.id, line: costLine(unitCost(u)) })),
      // Per kind of agent (builders, general and specialist critics, fold-in checks), with its share.
      byKind: costByKind([run]).map((g) => ({ kind: g.kind, label: g.label, line: costLine(g), share: g.share, shareOf: g.shareOf })),
    },
    // Each critic setup (verdict --critic) with the rounds it judged and passed (lib/rules.mjs).
    critics: criticSetups([run]),
    // Pauses by hand, for the timeline: [{ from, to }], to null while one is open.
    pauses: (Array.isArray(run.pauses) ? run.pauses : []).filter((p) => p?.from).map((p) => ({ from: p.from, to: p.to ?? null })),
    escapes: { ...escapes(run), bySetup: bySetup([run]), list: notes.filter((n) => n.kind === 'escape').map((n) => ({ unit: n.unit, round: n.round ?? null, text: n.text, at: n.at })) },
    units: run.units.map((u) => {
      const last = u.rounds.at(-1);
      const d = next.get(u.id);
      const chain = chainOf(linked ?? new Map([[run.id, run]]), run.id, u.id);
      const tries = tryTimes(u, end);
      return {
        id: u.id, title: u.title ?? null, link: u.link ?? null, status: u.status, shipped: u.shipped ?? null, after: u.after ?? null,
        sentence: sentence(u, d), attention: attention(u, d), attentionLabel: attentionLabel(attention(u, d)),
        lastBeat: ['building', 'judging'].includes(u.status) ? agoText(u.heartbeatAt ?? run.createdAt, nowMs, timeZone) : null,
        dot: dots.get(u.id), badge: stateBadge(dots.get(u.id), u, d), finished: ['passed', 'stopped'].includes(dots.get(u.id)),
        // Depends on (its after) and blocks (units whose after names it), each with its state.
        dependsOn: waitIds(u).map(brief), dependents: run.units.filter((x) => waitIds(x).includes(u.id)).map((x) => brief(x.id)),
        rounds: u.rounds.length, maxRounds: roundCap(u, run), extraRounds: u.extraRounds ?? 0,
        // The same work in other runs (#36): earlier tries before, the run that finished it after.
        chain, chainText: chainLine(chain, u.id),
        // Files an already merged unit changed too (#37): take the target in before review.
        sync: syncs.has(u.id) ? syncStep(run.id, u.id, syncs.get(u.id), u.status === 'pass') : null,
        scores: u.rounds.map((r) => ({ score: typeof r.score === 'number' ? r.score : null, verdict: r.verdict })),
        gap: u.status === 'pass' ? null : (last?.gap ?? null), cause: u.status === 'pass' ? null : (last?.cause ?? null),
        // A round the general critic passed and a specialist failed (#126): who failed it, and the general verdict and score.
        failedBy: u.status !== 'pass' && last?.failedBy ? { specialists: last.failedBy, general: last.general ?? null, score: typeof last.score === 'number' ? last.score : null } : null,
        evidence: gapEvidence(last), // with its gap: a specialist's own when it failed the round (#147)
        next: label(d),
        personNotes: personNotes.filter((n) => n.unit === u.id),
        // The lead's decisions, follow-ups and info about this unit (note --unit, #45).
        unitNotes: notes.filter((n) => n.unit === u.id && ['decision', 'follow-up', 'info'].includes(n.kind)).map((n) => ({ kind: n.kind, text: n.text, at: n.at })),
        bar: u.bar, behaviours: u.behaviours ?? [], statechart: u.statechart ?? null, evidenceItems: u.evidence ?? [], links: u.links ?? [],
        who: whoUnit(u), // which model built and judged (lib/models.mjs)
        roundList: u.rounds, stopReason: u.stopReason ?? null,
        // Early reviews (verdict --early, #66): every one on the unit page, the ones since the last round counted.
        earlyList: Array.isArray(u.early) ? u.early : [], early: earlySummary(u),
        // Files in the unit's last checked diff (the gaming check records the count); null before one.
        files: typeof u.detect?.files === 'number' ? u.detect.files : null,
        asks: qs.filter((q) => q.unit === u.id), timeline: unitTimeline(run, u.id),
        // Each try's start and end stamps, and the working time they add up to (lib/timeline.mjs).
        tries, time: workTime(tries),
        // Other units that change the same files (planned, or in their last checked diff).
        overlaps: overlapsOf(run, u),
      };
    }),
    integration: integ.map((r) => r.verdict),
    next: nextStep(run, plan),
    decisions: pick('decision'),
    // Only open questions are "questions"; the rest are answered: by the person or the lead, or closed by a decision note.
    questions: qs.filter((q) => q.open).map((q) => ({ id: q.id, label: q.label, text: `${q.id}: ${q.text}${q.recommend ? ` · recommended: ${q.recommend}` : ''}` })),
    answeredQuestions: qs.filter((q) => !q.open).map((q) => {
      const d = notes.filter((n) => n.kind === 'decision' && n.answers === q.id).at(-1) ?? null;
      return {
        id: q.id, label: q.label, title: q.header || clip(String(q.text).split('\n')[0], 90), status: q.status,
        answer: q.answer ? answerText(q.answer) : (d?.text ?? ''), by: q.answer ? q.answer.by : 'lead', at: q.answer?.at ?? d?.at ?? null,
        decision: d && (!q.answer || d.text !== answerText(q.answer)) ? d.text : null,
      };
    }),
    followUps: pick('follow-up'),
    // The maps attach each follow-up to its unit (lib/maps.mjs).
    followUpNotes: notes.filter((n) => n.kind === 'follow-up').map((n) => ({ text: n.text, unit: n.unit ?? null, at: n.at })),
    timeline,
  };
}

export const trend = (scores) => scores.map((s) => (s.score === null ? '–' : String(s.score))).join(' → ');

// The compact text HUD: the situation first, then a dozen lines of detail.
// "failed by specialist money (general critic: pass, 9)": the critic that failed a round the general critic passed.
const failedByText = (f) => `failed by specialist ${f.specialists.join(', ')} (general critic: ${f.general ?? 'pass'}${f.score === null ? '' : `, ${f.score}`})`;

// Who leads the run (lib/lead.mjs): its tool, since when, last active; gone, and how it is taken over.
const leadLine = (v) => (!v.lead ? 'none recorded yet: the next lead step claims the run'
  : `${v.lead.tool} · since ${v.lead.since ?? 'unknown'} · last active ${v.lead.lastActive ?? 'unknown'}${v.lead.gone ? ` · gone (${v.lead.goneText}): run.mjs lead ${v.id} takes it over` : ''}`);
export function text(v) {
  const w = Math.max(4, ...v.units.map((u) => u.id.length)) + 2;
  const budget = v.budget.map((b) => `${b.name} ${b.used}/${b.max}${b.unit ? ` ${b.unit}` : ''}${b.note ? ` (${b.note})` : ''}`).join(' · ');
  const needs = v.needsYou.length
    ? v.needsYou.flatMap((q, i) => [`${i ? ' '.repeat(11) : 'needs you  '}${q.label}`, `${' '.repeat(11)}${q.id}: ${clip(q.text, 120)}${q.recommend ? ` → recommended: ${clip(q.recommend, 80)}` : ''}`])
    : ['needs you  nothing'];
  const answered = v.answered.flatMap((q) => [`answered   ${q.label}`, `${' '.repeat(11)}${q.id}: ${clip(answerText(q.answer), 100)} (by ${q.answer.by}; the lead has not used it yet)`]);
  const lines = [
    `${v.id} [${v.tag}] · ${v.status.word} · started ${v.startedText ?? v.started.slice(0, 16).replace('T', ' ')}`,
    ...statusLines(v.status),
    `phase      ${v.phase}`,
    ...(v.open ? [`lead       ${leadLine(v)}`] : []),
    `situation  ${clip(v.situation.text, 240)}`,
    ...needs,
    ...answered,
    `time left  ${v.timeLeft}`,
    '',
    `budget  ${budget}`,
    '',
    `${'unit'.padEnd(w)}${'status'.padEnd(10)}${'round'.padEnd(7)}${'scores'.padEnd(18)}next`,
  ];
  for (const u of v.units) {
    const bs = u.behaviours.length ? ` · behaviours ${u.behaviours.filter((b) => b.status === 'pass').length}/${u.behaviours.length}` : '';
    lines.push(`${u.id.padEnd(w)}${(u.shipped ? 'shipped' : u.status).padEnd(10)}${`${u.rounds}/${u.maxRounds}`.padEnd(7)}${(trend(u.scores) || '–').padEnd(18)}${u.next}${bs}`);
    lines.push(`${' '.repeat(w)}${u.attention ? `[${u.attentionLabel.toLowerCase()}] ` : ''}${clip(u.sentence, 160)}`);
    if (u.lastBeat) lines.push(`${' '.repeat(w)}last beat ${u.lastBeat}`);
    if (u.gap) lines.push(`${' '.repeat(w)}└ ${u.failedBy ? `${failedByText(u.failedBy)}: ` : ''}${clip(u.gap, 100)}${u.cause ? ` [cause: ${clip(u.cause, 40)}]` : ''}`);
    if (u.early) lines.push(`${' '.repeat(w)}◦ ${clip(u.early.text, 200)}`);
    if (u.sync) lines.push(`${' '.repeat(w)}⇄ ${clip(u.sync, 200)}`);
    if (u.chainText) lines.push(`${' '.repeat(w)}↔ ${clip(u.chainText, 200)}`);
  }
  if (v.integration.length) lines.push(`integration  ${v.integration.join(' → ')}`);
  if (v.models?.length || v.modelsUnrecorded) lines.push(`models   ${modelLine(v.models, v.modelsUnrecorded)}`);
  if (v.escapes?.escapes) lines.push(`escapes  ${escapeLine(v.escapes)}`);
  if (v.cost) {
    lines.push(`cost     run: ${v.cost.run}`, `         by unit: ${v.cost.byUnit.map((u) => `${u.id}: ${u.line}`).join('; ') || 'no units'}`);
    if (v.cost.byModel.length) lines.push(`         by model: ${v.cost.byModel.map((m) => `${m.model}: ${m.line}`).join('; ')}`);
  }
  const setups = (v.escapes?.bySetup ?? []).filter((g) => g.setup !== '(not recorded)' || g.escapes);
  if (setups.length) lines.push(`critics  ${setups.map((g) => `${clip(g.setup, 50)}: ${g.escapes} escape${g.escapes === 1 ? '' : 's'} in ${g.passed} passed (rate ${g.rate})`).join(' · ')}`);
  const gb = v.goalCheck.behaviours;
  lines.push(`goal    ${v.goalCheck.met ? 'met' : 'not yet'}${gb.length ? ` (${gb.filter((b) => b.status === 'pass').length}/${gb.length} behaviours pass)` : ''}`);
  lines.push('', `next    ${v.next}`, `open    ${v.needsYou.length} questions · ${v.followUps.length} follow-ups · ${v.decisions.length} decisions`);
  return `${lines.join('\n')}\n`;
}

// The status block of `show`: the word, progress and ETA; a concluded run says it is finished.
export function statusLines(st) {
  if (st.concluded) {
    return [
      `status     ${st.word}. This run is finished: ${st.reason}.`,
      `delivered  ${st.delivered.length ? st.delivered.join('; ') : 'nothing'}`,
      `progress   ${st.progress} · follow-ups ${st.followUps} in Gaps`,
    ];
  }
  return [
    `status     ${st.word}${st.needsYou.length ? ` (${st.needsYou.map((q) => q.id).join(', ')})` : ''}`,
    `progress   ${st.progress} · ${st.doing}`,
    `eta        ${st.eta.text}`,
  ];
}

// "2 of 5 passed units (rate 0.4)": defects found after a pass.
export const escapeLine = (e) => `${e.escapes} of ${e.passed} passed unit${e.passed === 1 ? '' : 's'}${e.rate === null ? '' : ` (rate ${e.rate})`}`;
