// The tracker comment: one per unit on each issue or PR it links, edited in
// place (design 6.1). It is a view of the run, never a source of truth, and it
// is the same text whoever writes it (the lead through gh, or the service).
// Run text is untrusted: every piece of it goes in an inline code span, where
// GitHub renders no Markdown, no HTML, no autolinked URL and no @mention. `detail` adds the last gap, cause and
// question headers; leave it off when the comment lands in a repo whose readers
// may not read the run (a public repo, or another repo than the state's).
import { questions } from './questions.mjs';

export const marker = (run, unit) => `<!-- coordinator:tracker run=${run} unit=${unit} -->`;
export const isTracker = (body, run, unit) => String(body ?? '').startsWith(marker(run, unit));

const MAX = 200;
// One line of untrusted text as an inline code span: whitespace collapsed, clipped, and fenced
// with one more backtick than the longest run inside, so it cannot close the span early.
export function md(text, max = MAX) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const clipped = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  if (!clipped) return '';
  const fence = '`'.repeat(Math.max(0, ...(clipped.match(/`+/g) ?? []).map((x) => x.length)) + 1);
  const pad = /^`|`$/.test(clipped) || /^ .* $/.test(clipped) ? ' ' : '';
  return `${fence}${pad}${clipped}${pad}${fence}`;
}

// A unit's state on the board and in the comment: building, judging, passed, stopped or needs you.
export function unitState(run, u) {
  if (u.status === 'pass') return 'passed';
  if (u.status === 'stopped') return 'stopped';
  if (!run.closed && questions(run).some((q) => q.open && q.unit === u.id)) return 'needs you';
  return u.status === 'judging' ? 'judging' : 'building';
}

// run: the state; unit: its id; url: the unit's page on the web dashboard, or null;
// github: extra lines about the unit's PRs (merged, checks), already plain text.
export function trackerBody(run, unitId, { url = null, detail = false, github = [] } = {}) {
  const u = run.units.find((x) => x.id === unitId);
  if (!u) return null;
  const rounds = u.rounds ?? [];
  const last = rounds.at(-1);
  const scores = rounds.map((r) => (typeof r.score === 'number' ? r.score : '–')).join(' → ');
  const lines = [
    marker(run.id, u.id),
    `**Coordinator** · run ${md(run.id, 64)} · unit ${md(u.id, 64)}${u.title ? `: ${md(u.title, 120)}` : ''}`,
    '',
    `- **State:** ${unitState(run, u)}${run.closed ? ` (run closed: ${md(run.closed.outcome, 40)})` : ''}`,
    `- **Tries:** ${rounds.length} of ${run.budget?.maxRounds ?? '?'}${scores ? ` · scores ${scores}` : ''}${last ? ` · last verdict ${md(last.verdict, 20)}` : ''}`,
  ];
  if (detail && last && last.verdict !== 'pass' && (last.gap || last.cause)) lines.push(`- **Last gap:** ${md(last.gap ?? '')}${last.cause ? ` (cause: ${md(last.cause, 80)})` : ''}`);
  const open = run.closed ? [] : questions(run).filter((q) => q.open && q.unit === u.id);
  if (open.length) lines.push(`- **Waiting on a person:** ${open.length} open question${open.length === 1 ? '' : 's'}${detail ? ` (${open.map((q) => md(q.header || q.text, 60)).join('; ')})` : ''}`);
  for (const g of github) lines.push(`- ${md(g)}`);
  if (url) lines.push('', `[Open the unit on the dashboard](${url})`);
  lines.push('', '<sub>Kept current by the coordinator. Edits here are overwritten.</sub>');
  return `${lines.join('\n')}\n`;
}
