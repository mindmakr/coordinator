// The run's retro (/retro when served, retro.html in the snapshot): its retro
// notes, the lessons it added (lessons.mjs, both scopes), its budget against
// what past runs suggest, its upstream proposals and its escapes. Pure: the
// CLI passes the run, the lessons and the closed runs in. Also decides when a
// run's retro is pending, for the dashboard's banner and close's warning.
import { liveCtx, staticCtx } from './hud.mjs';
import { linkify } from './links.mjs';
import { blk, chip, esc, page, stamp } from './parts.mjs';
import { stats } from './rules.mjs';

const UPSTREAM = /^\s*upstream\s*:|github\.com\/mindmakr\/coordinator\b|mindmakr\/coordinator#\d/i;
const DECIDED = ['done', 'done-with-gaps', 'stopped'];

export const hasRetro = (run) => (run.notes ?? []).some((n) => n.kind === 'retro');
export const retroCommand = (run) => `/coordinator:retro ${run.id}`;
// Pending once every unit is decided (passed or stopped) or the run reached an end decision, until a retro note exists.
export function retroPending(run, decision) {
  if (hasRetro(run) || !run.units.length) return false;
  return DECIDED.includes(run.closed?.decision ?? decision) || run.units.every((u) => ['pass', 'stopped'].includes(u.status));
}

// lessons: [{ id, tag, text, seen, used, from, scope }] of both scopes; closed: the folder's closed runs (for the suggested budget).
export function retroModel(run, { lessons = [], closed = [] } = {}) {
  const notes = run.notes ?? [];
  const retro = notes.filter((n) => n.kind === 'retro');
  const sameTag = closed.filter((r) => r.tag === run.tag && r.id !== run.id);
  const s = sameTag.length ? stats(sameTag) : null;
  return {
    id: run.id, tag: run.tag, closed: run.closed ?? null, has: retro.length > 0,
    notes: retro.filter((n) => !UPSTREAM.test(n.text)).map((n) => ({ text: n.text, at: n.at })),
    upstream: notes.filter((n) => ['retro', 'follow-up'].includes(n.kind) && UPSTREAM.test(n.text)).map((n) => ({ text: n.text, at: n.at, kind: n.kind })),
    lessons: lessons.filter((l) => (l.from ?? []).includes(run.id)),
    escapes: notes.filter((n) => n.kind === 'escape').map((n) => ({ unit: n.unit, round: n.round ?? null, text: n.text, at: n.at })),
    budget: {
      rounds: run.budget.maxRounds, minutes: run.budget.maxMinutes, units: run.budget.maxUnits,
      usedRounds: Math.max(0, ...run.units.map((u) => u.rounds.length)),
      // A reset (run.mjs reset, after a crash) ends a build with no verdict, so no round: count builds from the log.
      builds: Math.max(0, ...run.units.map((u) => Math.max(u.rounds.length, (u.log ?? []).filter((e) => e.kind === 'start').length))),
      resets: run.units.reduce((n, u) => n + (u.log ?? []).filter((e) => e.kind === 'reset').length, 0),
      stopped: run.units.filter((u) => u.status === 'stopped').map((u) => ({ id: u.id, reason: u.stopReason ?? '' })),
      // Same rule as learning.md: the 80th percentile of rounds to pass, plus 1, at most 8.
      suggested: s?.p80RoundsToPass ? Math.min(8, s.p80RoundsToPass + 1) : null, from: sameTag.length,
    },
  };
}

const list = (xs, fn, none) => (xs.length ? `<ul class="plain">${xs.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : `<p class="empty">${esc(none)}</p>`);
const card = (title, n, body) => `<section class="card"><h3>${esc(title)} <span class="chip">${n}</span></h3>${body}</section>`;

// closed: the run was closed without a retro; the retro can still be written.
export function pendingBanner(run, closed = false) {
  return `<div class="needs" data-a="retro-pending"><b>Retro pending.</b> ${closed ? 'The run closed without a retro' : 'Every unit is decided'}: run <code>${esc(retroCommand(run))}</code> to turn this run into lessons, budgets and upstream fixes${closed ? '' : ', then close it'}. <span class="cause">references/learning.md</span></div>`;
}

export function retroPage(m, v, nowMs = Date.now(), ctx = null, pending = false) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const r = v.repo; const b = m.budget;
  const budget = `<div class="budget"><div class="card stat"><span>Rounds per unit</span><b>${b.usedRounds} <span class="cause">of ${b.rounds} used at most${b.builds > b.usedRounds || b.resets ? `; ${b.builds} builds started, ${b.resets} reset` : ''}</span></b></div>`
    + `<div class="card stat" title="From the closed runs with the same tag: the 80th percentile of rounds to pass, plus 1"><span>Suggested --max-rounds</span><b>${b.suggested ?? '–'} <span class="cause">${b.from ? `from ${b.from} closed ${esc(m.tag)} runs` : 'no closed run with this tag yet'}</span></b></div>`
    + `<div class="card stat"><span>Time budget</span><b>${b.minutes} <span class="cause">min</span></b></div><div class="card stat"><span>Units stopped</span><b>${b.stopped.length}</b></div></div>`
    + list(b.stopped, (s) => `<b>${esc(s.id)}</b> ${linkify(s.reason, r)}`, 'No unit stopped.');
  const body = [
    `<a class="back" href="${esc(ctx.home)}">← ${esc(v.id)} dashboard</a>`,
    blk('head', `<header class="run"><h1>Retro · ${esc(v.id)}</h1>${chip(m.has ? 'written' : 'not written', m.has ? 'pass' : 'not-yet')}<span class="meta">updated ${stamp(new Date(nowMs).toISOString())}</span>${ctx.report && !ctx.pages?.length ? `<a class="open" href="${esc(ctx.report)}">Report →</a>` : ''}</header>`),
    pending ? blk('retro-pending', pendingBanner({ id: v.id }, !v.open)) : '',
    !m.has && !pending ? `<p class="hint">No retro yet. It runs once every unit is decided: <code>${esc(retroCommand({ id: v.id }))}</code>.</p>` : '',
    '<h2>Budget</h2>', blk('retro-budget', budget),
    '<h2>What the run taught</h2>',
    blk('retro-lists', '<div class="lists">'
      + card('Retro notes', m.notes.length, list(m.notes, (n) => `${linkify(n.text, r)} <span class="cause">${stamp(n.at)}</span>`, 'None yet: S/run.mjs note <run> --kind retro --text "…"'))
      + card('Lessons added', m.lessons.length, list(m.lessons, (l) => `${chip(l.tag)} ${linkify(l.text, r)} <span class="cause">${esc(l.id)} · seen ${l.seen} · ${esc(l.scope ?? 'global')}</span>`, 'None from this run: S/lessons.mjs add --from <run>'))
      + card('Upstream proposals', m.upstream.length, list(m.upstream, (n) => `${linkify(n.text, r)} <span class="cause">${esc(n.kind)}, ${stamp(n.at)}</span>`, 'None.'))
      + card('Escapes', m.escapes.length, list(m.escapes, (e) => `<b>${esc(e.unit)}</b>${e.round ? ` <span class="cause">passed in try ${e.round}</span>` : ''} ${linkify(e.text, r)}`, 'No defect turned up after a pass.'))
      + '</div>'),
  ].join('\n');
  return page({ title: `Retro · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/retro`, closed: !v.open });
}
