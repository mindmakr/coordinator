// Fills the fixed hud.template.html from a view (lib/view.mjs), so every run's
// HUD looks the same. Everything from the state is escaped: gaps, notes and
// evidence are untrusted text. The page has no scripts and no network (its CSP
// forbids both), so it works opened from file:// and published as a page. A
// unit's --link is a plain anchor, and only when it is an http(s) URL.
import { readFileSync } from 'node:fs';
import { trend } from './view.mjs';

const TEMPLATE = readFileSync(new URL('./hud.template.html', import.meta.url), 'utf8');
const REFRESH_SECONDS = 15;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
const cls = (s) => String(s ?? '').toLowerCase().replace(/[^a-z-]/g, '');
const when = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
const pct = (used, max) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);

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

// Only plain web links become anchors; anything else is shown as text.
const href = (url) => (/^https?:\/\/[^\s"'<>]+$/i.test(url ?? '') ? esc(url) : null);

function unitCard(u) {
  const link = u.link ? (href(u.link) ? ` <a href="${href(u.link)}" rel="noreferrer">link</a>` : ` <span class="cause">${esc(u.link)}</span>`) : '';
  const flag = u.attention ? `<span class="chip flag" title="${esc(u.attention)}">needs attention</span> ` : '';
  const raw = [u.gap && `<dt>Last gap</dt><dd>${esc(u.gap)}${u.cause ? ` <span class="cause">cause: ${esc(u.cause)}</span>` : ''}</dd>`, u.evidence && `<dt>Evidence</dt><dd>${esc(u.evidence)}</dd>`].filter(Boolean).join('');
  return `<section class="card"><h3><span>${esc(u.title ? `${u.id} · ${u.title}` : u.id)}${link}</span><span>${flag}<span class="chip s-${cls(u.status)}">${esc(u.status)}</span></span></h3>`
    + `<p class="say">${esc(u.sentence)}</p>`
    + `<div class="row"><span>round ${u.rounds}/${u.maxRounds}${u.after ? ` · after ${esc(u.after)}` : ''}</span><span>${esc(trend(u.scores) || 'no score yet')}</span></div>`
    + bar(u.rounds, u.maxRounds)
    + (u.scores.length ? `<div class="row">${sparkline(u.scores)}</div>` : '')
    + (raw ? `<details class="raw"><summary>Gap and evidence</summary><dl>${raw}</dl></details>` : '')
    + `<div class="unit-next"><b>Next:</b> ${esc(u.next)}</div></section>`;
}

function needsYou(items) {
  if (!items.length) return '<div class="needs calm">Nothing needs you.</div>';
  return `<div class="needs"><b>Needs you</b><ul>${items.map((q) => `<li><b>${esc(q.id)}</b> ${esc(q.text)}${q.recommend ? `<br><span class="rec">Recommended: ${esc(q.recommend)}</span>` : ''}</li>`).join('')}</ul></div>`;
}

function list(title, items) {
  const body = items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="empty">None.</p>';
  return `<section class="card"><h3>${esc(title)} <span class="chip">${items.length}</span></h3>${body}</section>`;
}

function event(e) {
  const score = e.score === null ? '' : ` · ${e.score}`;
  const cause = e.cause ? ` <span class="cause">cause: ${esc(e.cause)}</span>` : '';
  return `<li><time datetime="${esc(e.at)}" title="${esc(when(e.at))}">${esc(e.at.slice(11, 16))}</time>`
    + `<span><span class="chip s-${cls(e.kind)}">${esc(e.kind)}</span></span>`
    + `<span>${e.who ? `<b>${esc(e.who)}${esc(score)}</b> ` : ''}${esc(e.text)}${cause}</span></li>`;
}

export function hud(v, nowMs = Date.now()) {
  const parts = {
    refresh: v.open ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : '',
    id: esc(v.id), tag: esc(v.tag), phase: esc(v.phase), phaseClass: cls(v.phase.replace(/^closed: /, '')),
    started: esc(when(v.started)), updated: esc(when(new Date(nowMs).toISOString())), next: esc(v.next),
    situation: esc(v.situation.text), situationMeta: v.situation.computed ? 'counted from the state' : esc(`the lead, ${when(v.situation.at)}`),
    needs: needsYou(v.needsYou), timeLeft: esc(v.timeLeft),
    goal: esc(v.goal), bar: esc(v.bar), fence: esc(v.fence),
    budget: v.budget.map((b) => `<div class="card"><div class="row" style="margin:0"><span>${esc(b.name)}</span><b>${b.used}/${b.max}${b.unit ? ` ${esc(b.unit)}` : ''}</b></div>${bar(b.used, b.max)}</div>`).join(''),
    units: v.units.length ? v.units.map(unitCard).join('') : '<p class="empty">No units yet.</p>',
    integration: v.integration.length ? `<h2>Integration</h2><p>${v.integration.map((r) => `<span class="chip s-${cls(r)}">${esc(r)}</span>`).join(' → ')}</p>` : '',
    lists: [list('Decisions', v.decisions), list('Questions to confirm', v.questions), list('Follow-ups', v.followUps)].join(''),
    timeline: v.timeline.length ? v.timeline.slice(0, 60).map(event).join('') : '<li class="empty">Nothing yet.</li>',
  };
  // One pass: text inserted for one placeholder is never scanned for another.
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k) => parts[k] ?? '');
}
