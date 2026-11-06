// What a person sees of a run at a glance, computed once from the state. The
// text view (`run.mjs show`) and hud.html both read this model, so they agree.
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

export function view(run, plan, nowMs = Date.now()) {
  const end = run.closed ? Date.parse(run.closed.at) : nowMs;
  const next = new Map(plan.units.map((u) => [u.id, u]));
  const integ = run.integration?.rounds ?? [];
  const notes = run.notes ?? [];
  const pick = (kind) => notes.filter((n) => n.kind === kind).map((n) => n.text);
  const timeline = [
    ...run.units.flatMap((u) => u.rounds.map((r) => ({ at: r.at, kind: r.verdict, who: `${u.id} r${r.n}`, score: r.score, text: r.verdict === 'pass' ? (r.evidence ?? '') : r.gap, cause: r.cause ?? null }))),
    ...integ.map((r, i) => ({ at: r.at, kind: r.verdict, who: `integration r${i + 1}`, score: null, text: r.verdict === 'pass' ? (r.evidence ?? '') : r.gap, cause: r.cause ?? null })),
    ...notes.map((n) => ({ at: n.at, kind: n.kind, who: '', score: null, text: n.text, cause: null })),
  ].filter((e) => e.at).sort((a, b) => b.at.localeCompare(a.at));
  return {
    id: run.id, tag: run.tag, goal: run.goal, bar: run.bar, fence: run.fence,
    phase: run.closed ? `closed: ${run.closed.outcome}` : plan.decision,
    open: !run.closed, started: run.createdAt,
    budget: [
      { name: 'time', used: Math.max(0, Math.round((end - Date.parse(run.createdAt)) / MINUTE)), max: run.budget.maxMinutes, unit: 'min' },
      { name: 'units', used: run.units.length, max: run.budget.maxUnits, unit: '' },
      { name: 'added after freeze', used: run.addedAfterFreeze ?? 0, max: run.budget.maxAdded, unit: '' },
      { name: 'integration rounds', used: integ.length, max: run.budget.maxRounds, unit: '' },
    ],
    units: run.units.map((u) => {
      const last = u.rounds.at(-1);
      return {
        id: u.id, status: u.status, after: u.after ?? null, rounds: u.rounds.length, maxRounds: run.budget.maxRounds,
        scores: u.rounds.map((r) => ({ score: typeof r.score === 'number' ? r.score : null, verdict: r.verdict })),
        gap: u.status === 'pass' ? null : (last?.gap ?? null), cause: u.status === 'pass' ? null : (last?.cause ?? null),
        next: label(next.get(u.id)),
      };
    }),
    integration: integ.map((r) => r.verdict),
    next: nextStep(run, plan),
    decisions: pick('decision'), questions: pick('question'), followUps: pick('follow-up'),
    timeline,
  };
}

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const trend = (scores) => scores.map((s) => (s.score === null ? '–' : String(s.score))).join(' → ');

// The compact text HUD: a dozen lines, readable in any terminal or chat.
export function text(v) {
  const w = Math.max(4, ...v.units.map((u) => u.id.length)) + 2;
  const budget = v.budget.map((b) => `${b.name} ${b.used}/${b.max}${b.unit ? ` ${b.unit}` : ''}`).join(' · ');
  const lines = [
    `${v.id} [${v.tag}] · ${v.phase} · started ${v.started.slice(0, 16).replace('T', ' ')}`,
    `budget  ${budget}`,
    '',
    `${'unit'.padEnd(w)}${'status'.padEnd(10)}${'round'.padEnd(7)}${'scores'.padEnd(18)}next`,
  ];
  for (const u of v.units) {
    lines.push(`${u.id.padEnd(w)}${u.status.padEnd(10)}${`${u.rounds}/${u.maxRounds}`.padEnd(7)}${(trend(u.scores) || '–').padEnd(18)}${u.next}`);
    if (u.gap) lines.push(`${' '.repeat(w)}└ ${clip(u.gap, 100)}${u.cause ? ` [cause: ${clip(u.cause, 40)}]` : ''}`);
  }
  if (v.integration.length) lines.push(`integration  ${v.integration.join(' → ')}`);
  lines.push('', `next    ${v.next}`, `open    ${v.questions.length} questions · ${v.followUps.length} follow-ups · ${v.decisions.length} decisions`);
  return `${lines.join('\n')}\n`;
}
