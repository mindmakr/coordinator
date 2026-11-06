// The dashboard: the fixed shell (hud.template.html, via lib/parts.mjs) filled
// from a view (lib/view.mjs), so every run looks the same. State text is
// untrusted: it is escaped, and only http(s) URLs and #refs become links.
// Without `ctx.live` it is the static hud.html: no scripts, no network, a
// read-only snapshot. With it (lib/serve.mjs) it is the live dashboard: forms,
// and one script, allowed by a per-response nonce, that patches blocks in place.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchor, linkify, shortRef, webUrl } from './links.mjs';
import { answerText, OTHER } from './questions.mjs';
import { badge, behaviourList, blk, chip, cls, esc, eventRow, evidenceList, page, stamp, timelineTools, toggle } from './parts.mjs';
import { trend } from './view.mjs';

export { esc };
const pct = (used, max) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);
const TIMELINE_MAX = 300;
const EMBED_MAX = 150 * 1024;

// How pages reach units and artifacts: on disk (relative files) or served (token in the URL).
export function staticCtx(runDir, depth = 0, theme = null) {
  const up = '../'.repeat(depth);
  return {
    live: null, theme, run: null, home: `${up}hud.html`,
    unitHref: (id) => `${up}units/${encodeURIComponent(id)}.html`,
    artHref: (file) => `${up}artifacts/${file.split('/').map(encodeURIComponent).join('/')}`,
    // Small screenshots go inline, so the snapshot shows them without loading anything.
    embed: (file) => {
      if (!runDir) return null;
      try { const b = readFileSync(join(runDir, 'artifacts', file)); return b.length <= EMBED_MAX ? `data:${mime(file)};base64,${b.toString('base64')}` : null; } catch { return null; }
    },
  };
}
const mime = (f) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[f.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

export function liveCtx({ token, nonce }, run, theme = null) {
  const t = `t=${encodeURIComponent(token)}`;
  return {
    live: { token, nonce }, theme, run, home: `/?${t}`, embed: null,
    unitHref: (id) => `/unit/${encodeURIComponent(id)}?${t}`,
    artHref: (file) => `/artifacts/${file.split('/').map(encodeURIComponent).join('/')}?${t}`,
  };
}

function bar(used, max) {
  const p = pct(used, max);
  return `<div class="bar"><i class="${p >= 90 ? 'hot' : ''}" style="width:${p}%"></i></div>`;
}

// Scores on a 0-10 scale, one dot per round coloured by verdict.
function sparkline(scores) {
  const W = 120; const H = 32; const pad = 4;
  const n = scores.length;
  const x = (i) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (s) => H - pad - (s / 10) * (H - 2 * pad);
  const pts = scores.map((s, i) => (s.score === null ? null : [x(i), y(s.score), s.verdict])).filter(Boolean);
  const line = pts.length > 1 ? `<polyline points="${pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')}"/>` : '';
  const dots = pts.map(([a, b, v]) => `<circle class="${v === 'pass' ? 'p' : 'f'}" cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="3"/>`).join('');
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="scores ${esc(trend(scores))}"><line x1="0" x2="${W}" y1="${y(10)}" y2="${y(10)}"/>${line}${dots}</svg>`;
}

const hidden = (live, fields) => [['t', live.token], ...(live.back ? [['back', live.back]] : []), ...fields].map(([k, val]) => `<input type="hidden" name="${k}" value="${esc(val)}">`).join('');
const recommended = ' <span class="chip s-pass">Recommended</span>';

export function noteForm(live, unit) {
  return `<form class="note" method="post" action="/note">${hidden(live, unit ? [['unit', unit]] : [])}`
    + `<label>${esc(unit ? `Note to the lead about ${unit}` : 'Note to the lead')}<textarea name="text" rows="2" maxlength="1000" required></textarea></label>`
    + '<button type="submit">Send note</button></form>';
}

function answerForm(q, live) {
  const a = q.answer; const type = q.multi ? 'checkbox' : 'radio';
  const opts = q.options.map((o, i) => `<label class="opt"><input type="${type}" name="choice" value="${esc(o.label)}"${a?.choices.includes(o.label) ? ' checked' : ''}>`
    + `<span><b>${esc(o.label)}${i === 0 ? recommended : ''}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('');
  const box = `<input type="text" name="other" maxlength="1000" value="${esc(a?.other ?? '')}" placeholder="Your own answer" aria-label="Other answer for ${esc(q.id)}"${q.options.length ? '' : ' required'}>`;
  const other = !q.options.length ? `<label class="opt"><span><b>Your answer</b>${box}</span></label>`
    : q.multi ? `<label class="opt"><span><b>Other</b><small>optional, as well as any options above</small>${box}</span></label>`
      : `<label class="opt"><input type="radio" name="choice" value="${OTHER}"${a?.other ? ' checked' : ''}><span><b>Other</b>${box}</span></label>`;
  return `<form class="ask" method="post" action="/answer">${hidden(live, [['q', q.id]])}`
    + `<fieldset><legend>${q.options.length ? (q.multi ? 'Pick any' : 'Pick one') : 'Write your answer'}</legend>${opts}${other}</fieldset>`
    + `<button type="submit">${a ? 'Change answer' : 'Submit'}</button></form>`;
}

function optionList(q) {
  if (!q.options.length) return '';
  return `<ul class="opts">${q.options.map((o, i) => `<li${q.answer?.choices.includes(o.label) ? ' class="picked"' : ''}><b>${esc(o.label)}</b>${i === 0 ? recommended : ''}${o.description ? ` · ${esc(o.description)}` : ''}</li>`).join('')}</ul>`;
}

export function questionItem(q, live, repo = null) {
  const head = `<p class="qtext">${q.header ? `<span class="chip">${esc(q.header)}</span> ` : ''}<b>${esc(q.id)}</b> ${linkify(q.text, repo)}${q.unit ? ` <span class="cause">· ${esc(q.unit)}</span>` : ''}</p>`;
  const rec = q.recommend && !q.options.length ? `<p class="rec">Recommended: ${esc(q.recommend)}</p>` : '';
  const changes = q.history.length - 1;
  const ans = q.answer ? `<p class="ans"><b>Answer:</b> ${esc(answerText(q.answer))} <span class="cause">by ${esc(q.answer.by)}, ${stamp(q.answer.at)}${changes > 0 ? `, changed ${changes} ${changes === 1 ? 'time' : 'times'}` : ''}</span></p>` : '';
  const body = live && ['open', 'answered'].includes(q.status) ? answerForm(q, live) : optionList(q);
  return `<li class="q" id="${esc(q.id)}">${head}${rec}${ans}${body}</li>`;
}

// The unit's own links (--link at add, then each `run.mjs link`), http(s) only.
export function unitLinks(u, repo) {
  const all = [...(u.link ? [{ kind: 'link', url: u.link }] : []), ...u.links];
  if (!all.length) return '';
  const one = (l) => (webUrl(l.url) ? anchor(webUrl(l.url), shortRef(webUrl(l.url), repo)) : esc(l.url));
  return `<div class="links">${all.map((l) => `<span>${badge(l.kind === 'merge' ? 'merge' : 'link', l.kind)} ${one(l)}${l.label ? ` ${esc(l.label)}` : ''}</span>`).join('')}</div>`;
}

function unitCard(u, ctx, form, repo) {
  const flag = u.attention ? `<span class="chip flag" title="${esc(`The lead is on it: ${u.attention}`)}">${esc(u.attentionLabel)}</span> ` : '';
  const raw = [u.gap && `<dt>Last gap</dt><dd>${linkify(u.gap, repo)}${u.cause ? ` <span class="cause">cause: ${esc(u.cause)}</span>` : ''}</dd>`, u.evidence && `<dt>Evidence</dt><dd>${linkify(u.evidence, repo)}</dd>`].filter(Boolean).join('');
  const passing = u.behaviours.filter((b) => b.status === 'pass').length;
  const html = `<h3><span>${esc(u.title ? `${u.id} · ${u.title}` : u.id)}</span><span>${flag}${chip(u.status, u.status)}</span></h3>`
    + unitLinks(u, repo)
    + `<p class="say">${esc(u.sentence)}</p>`
    + `<div class="row"><span>round ${u.rounds}/${u.maxRounds}${u.after ? ` · after ${esc(u.after)}` : ''}</span><span>${esc(trend(u.scores) || 'no score yet')}</span></div>`
    + bar(u.rounds, u.maxRounds)
    + (u.scores.length ? `<div class="row">${sparkline(u.scores)}</div>` : '')
    + (u.behaviours.length ? toggle(`u-${u.id}-beh`, `Behaviours · ${passing}/${u.behaviours.length} pass`, behaviourList(u.behaviours, repo)) : '')
    + (u.evidenceItems.length ? toggle(`u-${u.id}-ev`, `Evidence · ${u.evidenceItems.length}`, evidenceList(u.evidenceItems, repo, ctx, `u-${u.id}-ev`)) : '')
    + (raw ? toggle(`u-${u.id}-raw`, 'Gap and evidence', `<dl>${raw}</dl>`) : '')
    + `<div class="unit-next"><b>Next:</b> ${esc(u.next)}</div>`
    + u.personNotes.slice(-2).map((n) => `<p class="from"><b>From you:</b> ${linkify(n.text, repo)}</p>`).join('')
    + (form ? toggle(`u-${u.id}-note`, 'Add a note on this unit', noteForm(form, u.id)) : '')
    + `<div class="row"><a class="open" href="${esc(ctx.unitHref(u.id))}">Open ${esc(u.id)} →</a></div>`;
  return blk(`unit-${u.id}`, html, 'section', ` class="card" id="unit-${esc(u.id)}"`);
}

function needsYou(v, form) {
  const hint = form || !(v.needsYou.length + v.answered.length) ? ''
    : `<p class="hint">This copy is read-only. Answer in the chat, or ask the lead for the answer page (<code>run.mjs serve ${esc(v.id)}</code>).</p>`;
  const open = v.needsYou.length ? `<div class="needs"><b>Needs you</b><ul>${v.needsYou.map((q) => questionItem(q, form, v.repo)).join('')}</ul>${hint}</div>`
    : `<div class="needs calm">Nothing needs you.${hint}</div>`;
  const answered = v.answered.length
    ? `<div class="needs calm"><b>Answered, waiting for the lead</b> <span class="cause">you can change these until the lead uses them</span><ul>${v.answered.map((q) => questionItem(q, form, v.repo)).join('')}</ul></div>` : '';
  return open + answered;
}

export function goalBlock(v, ctx) {
  const g = v.goalCheck;
  const passing = g.behaviours.filter((b) => b.status === 'pass').length;
  return `<section class="goal${g.met ? ' met' : ''}"><h3>Goal: ${chip(g.met ? 'met' : 'not yet', g.met ? 'met' : 'not-yet')}`
    + `${g.behaviours.length ? ` <span class="cause">${passing}/${g.behaviours.length} behaviours pass</span>` : ''}</h3><p>${linkify(v.goal, v.repo)}</p>`
    + (g.behaviours.length ? behaviourList(g.behaviours, v.repo, g.evidence, ctx, 'goal') : '')
    + evidenceList(g.evidence.filter((e) => !e.behaviour), v.repo, ctx, 'goal-ev') + '</section>';
}

function list(title, items, repo) {
  const body = items.length ? `<ul>${items.map((t) => `<li>${linkify(t, repo)}</li>`).join('')}</ul>` : '<p class="empty">None.</p>';
  return `<section class="card"><h3>${esc(title)} <span class="chip">${items.length}</span></h3>${body}</section>`;
}

export function timelineList(events, repo) {
  return events.length ? events.slice(0, TIMELINE_MAX).map((e) => eventRow(e, repo)).join('') : '<li class="empty">Nothing yet.</li>';
}

export function hud(v, nowMs = Date.now(), ctx = null) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id); // older callers pass { token, nonce }
  const form = ctx.live && v.open ? ctx.live : null; // a closed run takes no answers
  const r = v.repo;
  const body = [
    blk('head', `<header class="run"><h1>${esc(v.id)}</h1>${chip(v.phase, cls(v.phase.replace(/^closed: /, '')))}<span class="meta">${esc(v.tag)} · started ${stamp(v.started)} · updated ${stamp(new Date(nowMs).toISOString())}</span></header>`),
    blk('situation', `<div class="situation"><p>${linkify(v.situation.text, r)}</p><p class="meta">Situation · ${v.situation.computed ? 'counted from the state' : `the lead, ${stamp(v.situation.at)}`}</p></div>`),
    blk('goal', goalBlock(v, ctx)),
    blk('needs', needsYou(v, form)),
    form ? blk('note', noteForm(form)) : '',
    blk('eta', `<div class="eta"><b>Time left</b>${esc(v.timeLeft)}</div><div class="next"><b>Next</b>${esc(v.next)}</div>`),
    blk('gbf', toggle('gbf', 'Goal, bar and fence', `<dl><dt>Goal</dt><dd>${linkify(v.goal, r)}</dd><dt>Bar</dt><dd>${linkify(v.bar, r)}</dd><dt>Fence</dt><dd>${linkify(v.fence, r)}</dd></dl>`, '')),
    '<h2>Budget</h2>',
    blk('budget', v.budget.map((b) => `<div class="card"><div class="row" style="margin:0"><span>${esc(b.name)}</span><b>${b.used}/${b.max}${b.unit ? ` ${esc(b.unit)}` : ''}</b></div>${bar(b.used, b.max)}</div>`).join(''), 'div', ' class="budget"'),
    '<h2>Units</h2>',
    '<p class="legend"><b>Needs you</b> = waiting on you; <b>Retrying</b> = the lead is on it; <b>Quiet</b> = the lead is checking on a silent agent.</p>',
    blk('units', v.units.length ? v.units.map((u) => unitCard(u, ctx, form, r)).join('') : '<p class="empty">No units yet.</p>', 'div', ' class="grid"'),
    blk('integration', v.integration.length ? `<h2>Integration</h2><p>${v.integration.map((x) => chip(x, x)).join(' → ')}</p>` : ''),
    '<h2>Decisions, questions and follow-ups</h2>',
    blk('lists', [list('Decisions', v.decisions, r), list('Questions', v.questions, r), list('Follow-ups', v.followUps, r),
      list('Notes from you', v.personNotes.map((n) => `${n.unit ? `${n.unit}: ` : ''}${n.text}`), r)].join(''), 'div', ' class="lists"'),
    '<h2 id="timeline">Timeline</h2>',
    ctx.live ? timelineTools(v.units.map((u) => u.id)) : '',
    blk('timeline', timelineList(v.timeline, r), 'ol', ' class="timeline" data-tl-list'),
  ].join('\n');
  return page({ title: `${v.id} · Coordinator`, body, ctx, path: '/' });
}

