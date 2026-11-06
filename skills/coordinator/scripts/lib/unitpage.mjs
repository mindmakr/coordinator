// One unit's page (/unit/<id> when served, units/<id>.html on disk): its bar
// and behaviours with their evidence, every round, notes and questions for it,
// its links and its own timeline. Same shell, same rules as the dashboard.
import { linkify } from './links.mjs';
import { liveCtx, noteForm, questionItem, scoreChart, staticCtx, timelineList, triesRow, unitLinks } from './hud.mjs';
import { behaviourList, blk, chip, dot, esc, evidenceList, hash, keyed, page, stamp, timelineTools } from './parts.mjs';

function round(r, repo) {
  const marks = (r.behaviours ?? []).map((m) => `<li data-a="r${r.n}-${esc(m.id)}">${chip(m.status, m.status)} <b>${esc(m.id)}</b>${m.evidence ? ` ${linkify(m.evidence, repo)}` : ''}</li>`).join('');
  return `<div class="round" data-a="round-${r.n}"><h4>Round ${r.n} ${chip(r.verdict, r.verdict)}${r.score !== null && r.score !== undefined ? ` <span class="cause">score ${esc(r.score)}</span>` : ''}`
    + `${r.cause ? ` <span class="cause">cause: ${esc(r.cause)}</span>` : ''} ${stamp(r.at, 'cause')}</h4>`
    + `<dl>${r.report ? `<dt>Builder's report</dt><dd>${linkify(r.report, repo)}</dd>` : ''}`
    + `${r.gap ? `<dt>Gap</dt><dd>${linkify(r.gap, repo)}</dd>` : ''}${r.evidence ? `<dt>Critic's evidence</dt><dd>${linkify(r.evidence, repo)}</dd>` : ''}</dl>`
    + (marks ? `<ul class="behaviours">${marks}</ul>` : '') + '</div>';
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
  const notes = keyed(u.personNotes, (n) => `n-${n.at}-${hash(n.text)}`).map(([n, k]) => `<li data-a="${esc(k)}">${linkify(n.text, r)} <span class="cause">${stamp(n.at)}</span></li>`).join('');
  const body = [
    `<a class="back" href="${esc(ctx.home)}">← ${esc(v.id)} dashboard</a>`,
    blk('head', `<header class="run"><h1>${dot(u.dot)} ${esc(u.title ? `${u.id} · ${u.title}` : u.id)}</h1>${chip(u.status, u.status)}`
      + `<span class="meta">updated ${stamp(new Date(nowMs).toISOString())}</span></header>`
      + unitLinks(u, r) + triesRow(u) + scoreChart(u.roundList) + `<p class="say" data-a="say">${esc(u.sentence)}</p><div class="next" data-a="next"><b>Next</b>${esc(u.next)}</div>`),
    '<h2 data-a="h-Bar">Bar and behaviours</h2>',
    blk('behaviours', `<section class="card"><p>${linkify(u.bar, r)}</p>${behaviourList(u.behaviours, r, u.evidenceItems, ctx, `p-${u.id}`)}</section>`),
    '<h2 data-a="h-Evidence">Evidence and artifacts</h2>',
    blk('evidence', `<section class="card">${loose.length ? evidenceList(loose, r, ctx, `p-${u.id}-ev`) : '<p class="empty">No evidence outside the behaviours.</p>'}</section>`),
    '<h2 data-a="h-Rounds">Rounds</h2>',
    blk('rounds', `<section class="card">${u.roundList.length ? u.roundList.map((x) => round(x, r)).join('') : '<p class="empty">No round yet.</p>'}${u.stopReason ? `<p><b>Stopped:</b> ${esc(u.stopReason)}</p>` : ''}</section>`),
    '<h2 data-a="h-Notes">Notes and questions</h2>',
    blk('notes', `<section class="card">${u.asks.length ? `<ul class="needs-list">${u.asks.map((q) => questionItem(q, form, r)).join('')}</ul>` : ''}`
      + (notes ? `<ul>${notes}</ul>` : (u.asks.length ? '' : '<p class="empty">None.</p>'))
      + (form ? noteForm(form, u.id) : '') + '</section>'),
    `<h2 id="timeline" data-a="h-timeline">Timeline of ${esc(u.id)}</h2>`,
    ctx.live ? timelineTools() : '',
    blk('timeline', timelineList([...u.timeline].reverse(), r), 'ol', ' class="timeline" data-tl-list'),
  ].join('\n');
  return page({ title: `${u.id} · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/unit/${u.id}`, closed: !v.open });
}
