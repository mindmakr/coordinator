// Renders a run as a short markdown page people can read without interrupting it.
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 120);

export function render(run, plan) {
  const next = Object.fromEntries(plan.units.map((u) => [u.id, u]));
  const lines = [
    `# Run ${run.id}: ${plan.decision}`,
    '',
    `- **Goal:** ${cell(run.goal)}`,
    `- **Bar:** ${cell(run.bar)}`,
    `- **Fence:** ${cell(run.fence)}`,
    `- **Budget:** ${run.budget.maxRounds} rounds/unit, ${run.budget.maxMinutes} min, ${run.budget.maxUnits} units (+${run.budget.maxAdded} after freeze)`,
    `- **Started:** ${run.createdAt}${run.closed ? ` · **Closed:** ${run.closed.outcome} ${run.closed.at}` : ''}`,
    '',
    '| Unit | Status | Rounds | Score | Last gap | Next |',
    '|---|---|---|---|---|---|',
  ];
  for (const u of run.units) {
    const last = u.rounds.at(-1);
    const n = next[u.id];
    lines.push(`| ${u.id} | ${u.status} | ${u.rounds.length} | ${last?.score ?? ''} | ${cell(last?.gap)} | ${cell(n ? `${n.action}${n.reason ? `: ${n.reason}` : ''}` : '')} |`);
  }
  const integ = run.integration?.rounds ?? [];
  if (integ.length) lines.push('', `**Integration:** ${integ.map((r) => r.verdict).join(' → ')}${integ.at(-1)?.gap ? ` (gap: ${cell(integ.at(-1).gap)})` : ''}`);
  const notes = run.notes.slice(-12);
  if (notes.length) lines.push('', '## Notes', ...notes.map((x) => `- ${x.at.slice(0, 16)} **${x.kind}:** ${cell(x.text)}`));
  return `${lines.join('\n')}\n`;
}
