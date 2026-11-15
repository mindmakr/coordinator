// The run's retro (/retro when served, retro.html in the snapshot): its retro
// notes, the lessons it added (lessons.mjs, both scopes), its budget against
// what past runs suggest, its upstream proposals and its escapes. Pure: the
// CLI passes the run, the lessons and the closed runs in. Also decides when a
// run's retro is pending, for the dashboard's banner and close's warning.
import { liveCtx, runCrumbs, staticCtx } from './hud.mjs';
import { linkify } from './links.mjs';
import { blk, cols, esc, heading, kpis, mdActions, page, panel, stamp, table, toneChip } from './parts.mjs';
import { sameGap, stats } from './rules.mjs';

const UPSTREAM = /^\s*upstream\s*:|github\.com\/mindmakr\/coordinator\b|mindmakr\/coordinator#\d/i;
const DECIDED = ['done', 'done-with-gaps', 'stopped'];

export const hasRetro = (run) => (run.notes ?? []).some((n) => n.kind === 'retro');
export const retroCommand = (run) => `/coordinator:retro ${run.id}`;
// Pending once every unit is decided (passed or stopped) or the run reached an end decision, until a retro note exists.
export function retroPending(run, decision) {
  if (hasRetro(run) || !run.units.length) return false;
  return DECIDED.includes(run.closed?.decision ?? decision) || run.units.every((u) => ['pass', 'stopped'].includes(u.status));
}

// Gaps the critic raised in two or more rounds (learning.md step 1): a failed round's gap, grouped by cause tag or wording,
// across the run's units. [{ gap, cause, units, rounds }]
export function repeatedGaps(run) {
  const groups = [];
  for (const u of run.units) {
    for (const r of u.rounds ?? []) {
      if (r?.verdict !== 'fail' || !(r.gap || r.cause)) continue;
      const g = groups.find((x) => sameGap(x.first, r));
      if (g) { g.rounds++; if (!g.units.includes(u.id)) g.units.push(u.id); } else groups.push({ first: r, gap: r.gap ?? r.cause, cause: r.cause ?? null, units: [u.id], rounds: 1 });
    }
  }
  return groups.filter((g) => g.rounds >= 2).map(({ first, ...g }) => g);
}

// lessons: [{ id, tag, text, seen, used, from, scope }] of both scopes; closed: the folder's closed runs (for the suggested budget).
export function retroModel(run, { lessons = [], closed = [] } = {}) {
  const notes = run.notes ?? [];
  const retro = notes.filter((n) => n.kind === 'retro');
  const sameTag = closed.filter((r) => r.tag === run.tag && r.id !== run.id);
  const s = sameTag.length ? stats(sameTag) : null;
  const repeated = repeatedGaps(run);
  const stopped = run.units.filter((u) => u.status === 'stopped');
  return {
    id: run.id, tag: run.tag, closed: run.closed ?? null, has: retro.length > 0,
    notes: retro.filter((n) => !UPSTREAM.test(n.text)).map((n) => ({ text: n.text, at: n.at })),
    upstream: notes.filter((n) => ['retro', 'follow-up'].includes(n.kind) && UPSTREAM.test(n.text)).map((n) => ({ text: n.text, at: n.at, kind: n.kind })),
    lessons: lessons.filter((l) => (l.from ?? []).includes(run.id)),
    escapes: notes.filter((n) => n.kind === 'escape').map((n) => ({ unit: n.unit, round: n.round ?? null, text: n.text, at: n.at })),
    repeated,
    // What learning.md asks of a retro, as far as the run's own data shows it done.
    checklist: [
      { label: 'Retro notes', done: retro.length > 0 },
      { label: 'Repeated gaps', done: repeated.length === 0 || lessons.some((l) => (l.from ?? []).includes(run.id)) },
      // Only with a stopped unit, and done when each one recorded why it stopped.
      ...(stopped.length ? [{ label: 'Stopped units', done: stopped.every((u) => !!u.stopReason) }] : []),
      { label: 'Run closed', done: !!run.closed },
    ],
    budget: {
      rounds: run.budget.maxRounds, minutes: run.budget.maxMinutes, units: run.budget.maxUnits,
      usedRounds: Math.max(0, ...run.units.map((u) => u.rounds.length)),
      // A reset (run.mjs reset, after a crash) ends a build with no verdict, so no round: count builds from the log.
      builds: Math.max(0, ...run.units.map((u) => Math.max(u.rounds.length, (u.log ?? []).filter((e) => e.kind === 'start').length))),
      resets: run.units.reduce((n, u) => n + (u.log ?? []).filter((e) => e.kind === 'reset').length, 0),
      usedUnits: run.units.length,
      stopped: stopped.map((u) => ({ id: u.id, reason: u.stopReason ?? '' })),
      // Same rule as learning.md: the 80th percentile of rounds to pass, plus 1, at most 8.
      suggested: s?.p80RoundsToPass ? Math.min(8, s.p80RoundsToPass + 1) : null, from: sameTag.length,
    },
  };
}

const inProject = (where) => (where ? ` in ${esc(where)}` : '');
export function pendingBanner(run, closed = false, where = null) {
  return `<div class="needs" data-a="retro-pending"><b>Retro pending.</b> ${closed ? 'The run closed without a retro' : 'Every unit is decided'}: run <code>${esc(retroCommand(run))}</code>${inProject(where)} to turn this run into lessons, budgets and upstream fixes${closed ? '' : ', then close it'}. <span class="cause">references/learning.md</span></div>`;
}

// The retro as Markdown, for Copy and Download.
export function retroMarkdown(m) {
  const b = m.budget;
  const section = (title, xs, fn) => (xs.length ? [`## ${title}`, ...xs.map((x) => `- ${fn(x)}`), ''] : []);
  return [
    `# Retro · ${m.id}`, '',
    '## Budget',
    `- Tries per unit: ${b.usedRounds} of ${b.rounds}${b.suggested ? `, suggested ${b.suggested}` : ''}`,
    `- Builds started: ${b.builds}${b.resets ? `, ${b.resets} reset` : ''}`,
    `- Time: ${b.minutes} min`, '',
    ...section('Retro notes', m.notes, (n) => n.text),
    ...section('Lessons', m.lessons, (l) => `${l.tag}: ${l.text} (${l.id})`),
    ...section('Repeated gaps', m.repeated, (g) => `${g.gap} (${g.units.join(', ')}; ${g.rounds} rounds)`),
    ...section('Stopped units', b.stopped, (s) => `${s.id}: ${s.reason}`),
    ...section('Upstream proposals', m.upstream, (n) => n.text),
    ...section('Escapes', m.escapes, (e) => `${e.unit}: ${e.text}`),
  ].join('\n').trimEnd();
}

const rows = (xs, fn, none) => (xs.length ? `<div class="rows">${xs.map((x) => `<div>${fn(x)}</div>`).join('')}</div>` : `<p class="empty">${esc(none)}</p>`);
const unitLink = (ctx, id) => `<a class="mono" href="${esc(ctx.unitHref(id))}">${esc(id)}</a>`;

export function retroPage(m, v, nowMs = Date.now(), ctx = null, pending = false) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const r = v.repo; const b = m.budget;
  const head = heading('Retro', '', {
    inlineHtml: `${toneChip(m.has ? 'written' : 'not written', m.has ? 'ok' : 'ask')}<span class="muted">updated ${stamp(new Date(nowMs).toISOString())}</span>`,
    actionsHtml: `${ctx.report && !ctx.pages?.length ? `<a class="open" href="${esc(ctx.report)}">Report →</a>` : ''}${mdActions(retroMarkdown(m), `retro-${v.id}.md`, { copy: !!ctx.live })}`,
  });
  const strip = kpis([
    { k: 'Tries per unit', v: `${b.usedRounds} of ${b.rounds}`, s: b.builds > b.usedRounds || b.resets ? `${b.builds} builds started, ${b.resets} reset` : 'most used by one unit', bar: b.rounds ? (100 * b.usedRounds) / b.rounds : undefined },
    { k: 'Suggested max rounds', v: b.suggested ?? '–', s: b.from ? `from ${b.from} closed ${m.tag} runs` : 'no closed run with this tag yet' },
    { k: 'Time budget', v: `${b.minutes} min` },
    { k: 'Lessons', v: m.lessons.length, s: 'added by this run' },
    { k: 'Escapes', v: m.escapes.length, s: 'found after a pass' },
  ]);
  const budget = table({
    cols: [{ label: 'Item' }, { label: 'Budget', num: true }, { label: 'Used', num: true }, { label: 'Next run', num: true }],
    rows: [
      ['Tries per unit', b.rounds, b.usedRounds, b.suggested ?? '–'],
      ['Builds started', '–', b.builds, '–'],
      ...(b.resets ? [['Resets', '–', b.resets, '–']] : []),
      ['Units', b.units ?? '–', b.usedUnits, '–'],
      ['Time, minutes', b.minutes, '–', '–'],
    ].map(([item, ...rest]) => [item, ...rest.map(String)]),
    min: 420,
  });
  const lessons = rows(m.lessons, (l) => `<span class="chip">${esc(l.tag)}</span><span class="grow">${linkify(l.text, r)}</span><span class="cause">${esc(l.id)} · seen ${l.seen} · ${esc(l.scope ?? 'global')}</span>`, 'None from this run: lessons.mjs add --from <run>');
  const gaps = table({
    cols: [{ label: 'Gap' }, { label: 'Units' }, { label: 'Rounds', num: true }],
    rows: m.repeated.map((g) => [g.gap, { html: g.units.map((u) => unitLink(ctx, u)).join(', ') }, String(g.rounds)]),
    min: 480, max: 280, empty: 'No gap came back in two or more rounds.',
  });
  const stopped = rows(b.stopped, (s) => `${unitLink(ctx, s.id)}<span class="grow">${linkify(s.reason, r)}</span>`, 'No unit stopped.');
  const checklist = `<div class="rows">${m.checklist.map((c) => `<div><span class="tag${c.done ? '' : ' open'}">${c.done ? 'DONE' : 'OPEN'}</span><span>${esc(c.label)}</span></div>`).join('')}</div>`;
  const done = m.checklist.filter((c) => c.done).length;
  const main = blk('retro-budget', panel({ id: 'budget', title: 'Budget', bodyHtml: budget, flush: true }))
    + blk('retro-notes', panel({ id: 'notes', title: 'Retro notes', count: m.notes.length, bodyHtml: rows(m.notes, (n) => `<span class="grow">${linkify(n.text, r)}</span><span class="cause">${stamp(n.at)}</span>`, 'None yet: run.mjs note <run> --kind retro --text "…"') }))
    + blk('retro-lessons', panel({ id: 'lessons', title: 'Lessons', count: m.lessons.length, bodyHtml: lessons }))
    + blk('retro-gaps', panel({ id: 'gaps', title: 'Repeated gaps', count: m.repeated.length, bodyHtml: gaps, flush: m.repeated.length > 0, open: false }))
    + blk('retro-stopped', panel({ id: 'stopped', title: 'Stopped units', count: b.stopped.length, bodyHtml: stopped, open: false }));
  const side = blk('retro-checklist', panel({ id: 'checklist', title: 'Checklist', count: `${done} / ${m.checklist.length}`, bodyHtml: checklist }))
    + blk('retro-upstream', panel({ id: 'upstream', title: 'Upstream proposals', count: m.upstream.length, bodyHtml: rows(m.upstream, (n) => `<span class="grow">${linkify(n.text, r)}</span><span class="cause">${esc(n.kind)}, ${stamp(n.at)}</span>`, 'None.') }))
    + blk('retro-escapes', panel({ id: 'escapes', title: 'Escapes', count: m.escapes.length, open: false, bodyHtml: rows(m.escapes, (e) => `${unitLink(ctx, e.unit)}${e.round ? `<span class="cause">passed in try ${e.round}</span>` : ''}<span class="grow">${linkify(e.text, r)}</span>`, 'No defect turned up after a pass.') }));
  const body = `<div class="stack">${[
    blk('head', head),
    pending ? blk('retro-pending', pendingBanner({ id: v.id }, !v.open, ctx.project)) : '',
    !m.has && !pending ? `<p class="hint">No retro yet. It runs once every unit is decided: <code>${esc(retroCommand({ id: v.id }))}</code>${inProject(ctx.project)}.</p>` : '',
    blk('kpis', strip),
    cols(main, side),
  ].join('\n')}</div>`;
  return page({ title: `Retro · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/retro`, closed: !v.open, crumbs: runCrumbs(v, ctx, 'Retro') });
}
