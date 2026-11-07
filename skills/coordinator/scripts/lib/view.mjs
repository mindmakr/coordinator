// What a person sees of a run at a glance, computed once from the state. The
// text view (`run.mjs show`) and hud.html both read this model, so they agree.
import { byModel, modelLine, unrecorded, UNSPECIFIED, whoUnit } from './models.mjs';
import { attention, attentionLabel, clip, dotState, sentence, situation, stateBadge, timeLeft, waitIds } from './plain.mjs';
import { answerText, questions } from './questions.mjs';
import { bySetup, escapes, unmet } from './rules.mjs';
import { runTimeline, unitTimeline } from './timeline.mjs';
import { retroPending } from './retro.mjs';

const MINUTE = 60_000;
const ACTIVE = ['build', 'judge', 'change-strategy', 'check-stale'];

const label = (d) => (d ? `${d.action}${d.reason ? `: ${d.reason}` : ''}${d.phase ? ` (${d.phase})` : ''}` : '');

function nextStep(run, plan) {
  if (run.closed) return `nothing: closed as ${run.closed.outcome}`;
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

export function view(run, plan, nowMs = Date.now(), { repo = null } = {}) {
  const end = run.closed ? Date.parse(run.closed.at) : nowMs;
  const next = new Map(plan.units.map((u) => [u.id, u]));
  const integ = run.integration?.rounds ?? [];
  const notes = run.notes ?? [];
  const pick = (kind) => notes.filter((n) => n.kind === kind).map((n) => n.text);
  const qs = questions(run);
  const personNotes = notes.filter((n) => n.kind === 'person').map((n) => ({ text: n.text, unit: n.unit ?? null, at: n.at }));
  const timeline = runTimeline(run).reverse();
  const goalBehaviours = run.goalBehaviours ?? [];
  // Each unit's state, and which units wait on which (for the links both ways).
  const dots = new Map(run.units.map((u) => [u.id, dotState(u, next.get(u.id), run.closed ? [] : qs)]));
  const brief = (id) => { const x = run.units.find((y) => y.id === id); const st = dots.get(id); return { id, title: x?.title ?? null, status: x?.status ?? null, dot: st ?? null, badge: x ? stateBadge(st, x, next.get(id)) : null }; };
  return {
    id: run.id, tag: run.tag, goal: run.goal, repo: run.repo ?? repo,
    goalCheck: {
      behaviours: goalBehaviours, evidence: run.goalEvidence ?? [],
      met: goalBehaviours.length ? !unmet(goalBehaviours).length : (run.closed?.outcome ?? plan.decision) === 'done',
    }, bar: run.bar, fence: run.fence,
    phase: run.closed ? `closed: ${run.closed.outcome}` : plan.decision,
    retroPending: retroPending(run, plan.decision), // every unit decided and no retro note yet (lib/retro.mjs)
    open: !run.closed, started: run.createdAt, closedAt: run.closed?.at ?? null,
    situation: situation(run, plan, run.closed ? [] : qs),
    needsYou: run.closed ? [] : qs.filter((q) => q.open),
    answered: run.closed ? [] : qs.filter((q) => q.status === 'answered'),
    asks: qs, personNotes,
    timeLeft: timeLeft(run, plan, nowMs),
    budget: [
      { name: 'time', used: Math.max(0, Math.round((end - Date.parse(run.createdAt)) / MINUTE)), max: run.budget.maxMinutes, unit: 'min' },
      { name: 'units', used: run.units.length, max: run.budget.maxUnits, unit: '' },
      { name: 'added after freeze', used: run.addedAfterFreeze ?? 0, max: run.budget.maxAdded, unit: '' },
      { name: 'integration rounds', used: integ.length, max: run.budget.maxRounds, unit: '' },
    ],
    // Rounds and pass rate per builder model, once any round recorded one (lib/models.mjs).
    models: byModel([run]).roundsByBuilderModel.filter((m) => !['(not recorded)', UNSPECIFIED].includes(m.model)),
    modelsUnrecorded: unrecorded(run),
    escapes: { ...escapes(run), bySetup: bySetup([run]), list: notes.filter((n) => n.kind === 'escape').map((n) => ({ unit: n.unit, round: n.round ?? null, text: n.text, at: n.at })) },
    units: run.units.map((u) => {
      const last = u.rounds.at(-1);
      const d = next.get(u.id);
      return {
        id: u.id, title: u.title ?? null, link: u.link ?? null, status: u.status, after: u.after ?? null,
        sentence: sentence(u, d), attention: attention(u, d), attentionLabel: attentionLabel(attention(u, d)),
        dot: dots.get(u.id), badge: stateBadge(dots.get(u.id), u, d), finished: ['passed', 'stopped'].includes(dots.get(u.id)),
        // Depends on (its after) and blocks (units whose after names it), each with its state.
        dependsOn: waitIds(u).map(brief), dependents: run.units.filter((x) => waitIds(x).includes(u.id)).map((x) => brief(x.id)),
        rounds: u.rounds.length, maxRounds: run.budget.maxRounds,
        scores: u.rounds.map((r) => ({ score: typeof r.score === 'number' ? r.score : null, verdict: r.verdict })),
        gap: u.status === 'pass' ? null : (last?.gap ?? null), cause: u.status === 'pass' ? null : (last?.cause ?? null),
        evidence: last?.evidence ?? null,
        next: label(d),
        personNotes: personNotes.filter((n) => n.unit === u.id),
        bar: u.bar, behaviours: u.behaviours ?? [], evidenceItems: u.evidence ?? [], links: u.links ?? [],
        who: whoUnit(u), // which model built and judged (lib/models.mjs)
        roundList: u.rounds, stopReason: u.stopReason ?? null,
        // Files in the unit's last checked diff (the gaming check records the count); null before one.
        files: typeof u.detect?.files === 'number' ? u.detect.files : null,
        asks: qs.filter((q) => q.unit === u.id), timeline: unitTimeline(run, u.id),
      };
    }),
    integration: integ.map((r) => r.verdict),
    next: nextStep(run, plan),
    decisions: pick('decision'),
    // Only open questions are "questions"; the rest are answered: by the person or the lead, or closed by a decision note.
    questions: qs.filter((q) => q.open).map((q) => `${q.id}: ${q.text}${q.recommend ? ` · recommended: ${q.recommend}` : ''}`),
    answeredQuestions: qs.filter((q) => !q.open).map((q) => {
      const d = notes.filter((n) => n.kind === 'decision' && n.answers === q.id).at(-1) ?? null;
      return {
        id: q.id, title: q.header || clip(String(q.text).split('\n')[0], 90), status: q.status,
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
export function text(v) {
  const w = Math.max(4, ...v.units.map((u) => u.id.length)) + 2;
  const budget = v.budget.map((b) => `${b.name} ${b.used}/${b.max}${b.unit ? ` ${b.unit}` : ''}`).join(' · ');
  const needs = v.needsYou.length
    ? v.needsYou.map((q, i) => `${i ? ' '.repeat(11) : 'needs you  '}${q.id}: ${clip(q.text, 120)}${q.recommend ? ` → recommended: ${clip(q.recommend, 80)}` : ''}`)
    : ['needs you  nothing'];
  const answered = v.answered.map((q) => `answered   ${q.id}: ${clip(answerText(q.answer), 100)} (by ${q.answer.by}; the lead has not used it yet)`);
  const lines = [
    `${v.id} [${v.tag}] · ${v.phase} · started ${v.started.slice(0, 16).replace('T', ' ')}`,
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
    lines.push(`${u.id.padEnd(w)}${u.status.padEnd(10)}${`${u.rounds}/${u.maxRounds}`.padEnd(7)}${(trend(u.scores) || '–').padEnd(18)}${u.next}${bs}`);
    lines.push(`${' '.repeat(w)}${u.attention ? `[${u.attentionLabel.toLowerCase()}] ` : ''}${clip(u.sentence, 160)}`);
    if (u.gap) lines.push(`${' '.repeat(w)}└ ${clip(u.gap, 100)}${u.cause ? ` [cause: ${clip(u.cause, 40)}]` : ''}`);
  }
  if (v.integration.length) lines.push(`integration  ${v.integration.join(' → ')}`);
  if (v.models?.length || v.modelsUnrecorded) lines.push(`models   ${modelLine(v.models, v.modelsUnrecorded)}`);
  if (v.escapes?.escapes) lines.push(`escapes  ${escapeLine(v.escapes)}`);
  const setups = (v.escapes?.bySetup ?? []).filter((g) => g.setup !== '(not recorded)' || g.escapes);
  if (setups.length) lines.push(`critics  ${setups.map((g) => `${clip(g.setup, 50)}: ${g.escapes} escape${g.escapes === 1 ? '' : 's'} in ${g.passed} passed (rate ${g.rate})`).join(' · ')}`);
  const gb = v.goalCheck.behaviours;
  lines.push(`goal    ${v.goalCheck.met ? 'met' : 'not yet'}${gb.length ? ` (${gb.filter((b) => b.status === 'pass').length}/${gb.length} behaviours pass)` : ''}`);
  lines.push('', `next    ${v.next}`, `open    ${v.needsYou.length} questions · ${v.followUps.length} follow-ups · ${v.decisions.length} decisions`);
  return `${lines.join('\n')}\n`;
}

// "2 of 5 passed units (rate 0.4)": defects found after a pass.
export const escapeLine = (e) => `${e.escapes} of ${e.passed} passed unit${e.passed === 1 ? '' : 's'}${e.rate === null ? '' : ` (rate ${e.rate})`}`;
