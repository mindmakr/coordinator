// One unit's page (/unit/<id> when served, units/<id>.html on disk): its bar
// and behaviours with their evidence, every round, notes and questions for it,
// its links and its own timeline, and the functions its diff touched (when
// computed). Same shell, same rules as the dashboard.
import { viewer, viewerEntries } from './evview.mjs';
import { linkify } from './links.mjs';
import { unitCalls } from './map/callsview.mjs';
import { clip } from './plain.mjs';
import { whoRound } from './models.mjs';
import { chainRow, liveCtx, noteForm, questionItem, scoreChart, staticCtx, timelineList, timelineOl, triesRow, unitLinks } from './hud.mjs';
import { behaviourList, blk, blocksLine, chip, esc, evidenceList, grows, hash, keyed, linkWaits, page, stamp, stateChip, timelineTools, unitDot, unitLink } from './parts.mjs';

// Depends on / Blocks: each linked unit with its state dot and badge, linked to its page.
function links(u, ctx) {
  const row = (x) => `<li data-a="dep-${esc(x.id)}">${x.dot ? `${unitDot(x)} ${unitLink(x.id, ctx)}${x.title ? ` ${esc(x.title)}` : ''} ${stateChip(x, ctx)}` : `${esc(x.id)} <span class="cause">not in this run</span>`}</li>`;
  const part = (h, list, none) => `<h3 class="sub">${h}</h3>${list.length ? `<ul class="deps">${list.map(row).join('')}</ul>` : `<p class="empty">${none}</p>`}`;
  return `<section class="card">${part('Depends on', u.dependsOn, 'Nothing: it can start on its own.')}${part('Blocks', u.dependents, 'No unit waits on it.')}</section>`;
}


function round(r, repo) {
  const marks = (r.behaviours ?? []).map((m) => `<li data-a="r${r.n}-${esc(m.id)}">${chip(m.status, m.status)} <b>${esc(m.id)}</b>${m.evidence ? ` ${linkify(m.evidence, repo)}` : ''}</li>`).join('');
  return `<div class="round" data-a="round-${r.n}"><h4>Round ${r.n} ${chip(r.verdict, r.verdict)}${r.score !== null && r.score !== undefined ? ` <span class="cause">score ${esc(r.score)}</span>` : ''}`
    + `${r.cause ? ` <span class="cause">cause: ${esc(r.cause)}</span>` : ''} ${stamp(r.at, 'cause')}</h4>`
    + (whoRound(r) ? `<p class="cause" data-a="r${r.n}-who">${esc(whoRound(r))}</p>` : '')
    + `<dl>${r.report ? `<dt>Builder's report</dt><dd>${linkify(r.report, repo)}</dd>` : ''}`
    + `${r.gap ? `<dt>Gap</dt><dd>${linkify(r.gap, repo)}</dd>` : ''}${r.evidence ? `<dt>Critic's evidence</dt><dd>${linkify(r.evidence, repo)}</dd>` : ''}</dl>`
    + (marks ? `<ul class="behaviours">${marks}</ul>` : '') + '</div>';
}

// The rounds this unit had in the runs it continues (#36), oldest first, one line each.
function earlier(c, repo, id) {
  const runs = (c?.before ?? []).filter((l) => l.known);
  if (!runs.length) return '';
  const line = (l, r) => `<li>${chip(r.verdict, r.verdict)} <b>${esc(l.run)}${l.unit !== id ? `:${esc(l.unit)}` : ''}</b> round ${esc(r.n)}${typeof r.score === 'number' ? ` · score ${esc(r.score)}` : ''}${r.gap ? ` · ${linkify(clip(r.gap, 200), repo)}` : ''}${r.cause ? ` <span class="cause">cause: ${esc(r.cause)}</span>` : ''}</li>`;
  const stops = runs.filter((l) => l.stopReason).map((l) => `<p><b>Stopped in ${esc(l.run)}${l.unit !== id ? `:${esc(l.unit)}` : ''}:</b> ${esc(l.stopReason)}</p>`).join('');
  return `<h3 data-a="h-earlier">Earlier runs</h3><ol class="earlier">${runs.flatMap((l) => l.rounds.map((r) => line(l, r))).join('') || '<li class="empty">No round there.</li>'}</ol>${stops}`;
}

export function unitPage(v, id, nowMs = Date.now(), ctx = null) {
  const u = v.units.find((x) => x.id === id);
  if (!u) return null;
  ctx ??= staticCtx('', 1);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const live = ctx.form ?? ctx.live;
  const form = live && v.open && !ctx.readOnly ? { ...live, back: `/unit/${u.id}` } : null; // forms come back here
  const r = v.repo;
  const loose = u.evidenceItems.filter((e) => !e.behaviour);
  const calls = ctx.calls?.get(u.id) ?? null; // lib/map/calls.mjs, map/calls/<unit>.json
  const notes = keyed(u.personNotes, (n) => `n-${n.at}-${hash(n.text)}`).map(([n, k]) => `<li data-a="${esc(k)}">${linkify(n.text, r)} <span class="cause">${stamp(n.at)}</span></li>`).join('');
  const body = [
    `<a class="back" href="${esc(ctx.home)}">← ${esc(v.id)} dashboard</a>`,
    blk('head', `<header class="run"><h1>${unitDot(u)} ${esc(u.title ? `${u.id} · ${u.title}` : u.id)}</h1>${stateChip(u, ctx)}`
      + `<span class="meta">updated ${stamp(new Date(nowMs).toISOString())}</span></header>`
      + unitLinks(u, r) + triesRow(u) + chainRow(u, ctx) + scoreChart(u.roundList) + `<p class="say" data-a="say">${linkWaits(u.sentence, u.dependsOn.map((x) => x.id), ctx)}</p>${blocksLine(u, ctx)}<div class="next" data-a="next"><b>Next</b>${linkWaits(u.next, u.dependsOn.map((x) => x.id), ctx)}</div>`),
    ...(u.dependsOn.length || u.dependents.length ? ['<h2 data-a="h-Deps">Depends on / Blocks</h2>', blk('deps', links(u, ctx))] : []),
    '<h2 data-a="h-Bar">Bar and behaviours</h2>',
    blk('behaviours', `<section class="card"><p>${linkify(u.bar, r)}</p>${behaviourList(u.behaviours, r, u.evidenceItems, ctx, `p-${u.id}`)}</section>`),
    '<h2 data-a="h-Evidence">Evidence and artifacts</h2>',
    blk('evidence', `<section class="card">${loose.length ? evidenceList(loose, r, ctx, `p-${u.id}-ev`) : '<p class="empty">No evidence outside the behaviours.</p>'}</section>`),
    ...(calls ? ['<h2 data-a="h-Calls">Function calls</h2>', blk('calls', `<section class="card">${unitCalls(calls, r, v.id, u.id)}</section>`)] : []),
    '<h2 data-a="h-Rounds">Rounds</h2>',
    blk('rounds', `<section class="card">${earlier(u.chain, r, u.id)}${u.roundList.length ? u.roundList.map((x) => round(x, r)).join('') : '<p class="empty">No round yet.</p>'}${u.stopReason ? `<p><b>Stopped:</b> ${esc(u.stopReason)}</p>` : ''}</section>`),
    '<h2 data-a="h-Notes">Notes and questions</h2>',
    blk('notes', `<section class="card">${u.asks.length ? `<ul class="needs-list">${u.asks.map((q) => questionItem(q, form, r)).join('')}</ul>` : ''}`
      + (notes ? grows(`<ul>${notes}</ul>`) : (u.asks.length ? '' : '<p class="empty">None.</p>'))
      + (form ? noteForm(form, u.id) : '') + '</section>'),
    `<h2 id="timeline" data-a="h-timeline">Timeline of ${esc(u.id)}</h2>`,
    ctx.live ? timelineTools() : '',
    blk('timeline', timelineOl(timelineList([...u.timeline].reverse(), r, undefined, ctx)), 'div', ' class="list-anchor"'),
    blk('evv', viewer(viewerEntries(v, u.id), ctx, r)),
  ].join('\n');
  return page({ title: `${u.id} · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/unit/${u.id}`, closed: !v.open });
}
