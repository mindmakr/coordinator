// One unit's page (/unit/<id> when served, units/<id>.html on disk): its bar
// and behaviours with their evidence, every round, notes and questions for it,
// its links and its own timeline. Same shell, same rules as the dashboard.
import { linkify } from './links.mjs';
import { liveCtx, noteForm, questionItem, staticCtx, timelineList, unitLinks } from './hud.mjs';
import { behaviourList, blk, chip, esc, evidenceList, page, timelineTools, when } from './parts.mjs';
import { trend } from './view.mjs';

function round(r, repo) {
  const marks = (r.behaviours ?? []).map((m) => `<li>${chip(m.status, m.status)} <b>${esc(m.id)}</b>${m.evidence ? ` ${linkify(m.evidence, repo)}` : ''}</li>`).join('');
  return `<div class="round"><h4>Round ${r.n} ${chip(r.verdict, r.verdict)}${r.score !== null && r.score !== undefined ? ` <span class="cause">score ${esc(r.score)}</span>` : ''}`
    + `${r.cause ? ` <span class="cause">cause: ${esc(r.cause)}</span>` : ''} <time class="cause" datetime="${esc(r.at)}">${esc(when(r.at))}</time></h4>`
    + `<dl>${r.report ? `<dt>Builder's report</dt><dd>${linkify(r.report, repo)}</dd>` : ''}`
    + `${r.gap ? `<dt>Gap</dt><dd>${linkify(r.gap, repo)}</dd>` : ''}${r.evidence ? `<dt>Critic's evidence</dt><dd>${linkify(r.evidence, repo)}</dd>` : ''}</dl>`
    + (marks ? `<ul class="behaviours">${marks}</ul>` : '') + '</div>';
}

export function unitPage(v, id, nowMs = Date.now(), ctx = null) {
  const u = v.units.find((x) => x.id === id);
  if (!u) return null;
  ctx ??= staticCtx('', 1);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const form = ctx.live && v.open ? { ...ctx.live, back: `/unit/${u.id}` } : null; // forms come back here
  const r = v.repo;
  const loose = u.evidenceItems.filter((e) => !e.behaviour);
  const notes = u.personNotes.map((n) => `<li>${linkify(n.text, r)} <span class="cause">${esc(when(n.at))}</span></li>`).join('');
  const body = [
    `<a class="back" href="${esc(ctx.home)}">← ${esc(v.id)} dashboard</a>`,
    blk('head', `<header class="run"><h1>${esc(u.title ? `${u.id} · ${u.title}` : u.id)}</h1>${chip(u.status, u.status)}`
      + `<span class="meta">round ${u.rounds}/${u.maxRounds} · scores ${esc(trend(u.scores) || 'none yet')} · updated ${esc(when(new Date(nowMs).toISOString()))}</span></header>`
      + unitLinks(u, r) + `<p class="say">${esc(u.sentence)}</p><div class="next"><b>Next</b>${esc(u.next)}</div>`),
    '<h2>Bar and behaviours</h2>',
    blk('behaviours', `<section class="card"><p>${linkify(u.bar, r)}</p>${behaviourList(u.behaviours, r, u.evidenceItems, ctx, `p-${u.id}`)}</section>`),
    '<h2>Evidence and artifacts</h2>',
    blk('evidence', `<section class="card">${loose.length ? evidenceList(loose, r, ctx, `p-${u.id}-ev`) : '<p class="empty">No evidence outside the behaviours.</p>'}</section>`),
    '<h2>Rounds</h2>',
    blk('rounds', `<section class="card">${u.roundList.length ? u.roundList.map((x) => round(x, r)).join('') : '<p class="empty">No round yet.</p>'}${u.stopReason ? `<p><b>Stopped:</b> ${esc(u.stopReason)}</p>` : ''}</section>`),
    '<h2>Notes and questions</h2>',
    blk('notes', `<section class="card">${u.asks.length ? `<ul class="needs-list">${u.asks.map((q) => questionItem(q, form, r)).join('')}</ul>` : ''}`
      + (notes ? `<ul>${notes}</ul>` : (u.asks.length ? '' : '<p class="empty">None.</p>'))
      + (form ? noteForm(form, u.id) : '') + '</section>'),
    `<h2 id="timeline">Timeline of ${esc(u.id)}</h2>`,
    ctx.live ? timelineTools() : '',
    blk('timeline', timelineList([...u.timeline].reverse(), r), 'ol', ' class="timeline" data-tl-list'),
  ].join('\n');
  return page({ title: `${u.id} · ${v.id} · Coordinator`, body, ctx, path: `/unit/${u.id}` });
}
