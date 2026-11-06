// Fills the fixed hud.template.html from a view (lib/view.mjs), so every run's
// HUD looks the same. Everything from the state is escaped: gaps, notes and
// evidence are untrusted text. The file has no scripts and no network (its CSP
// forbids both), so it works opened from file:// and published as a page. A
// unit's --link is a plain anchor, and only when it is an http(s) URL.
// `live` ({ token, nonce }) renders the answer page lib/serve.mjs serves: the
// same HUD plus forms, and one inline script allowed by its nonce.
import { readFileSync } from 'node:fs';
import { answerText, OTHER } from './questions.mjs';
import { trend } from './view.mjs';

const TEMPLATE = readFileSync(new URL('./hud.template.html', import.meta.url), 'utf8');
const REFRESH_SECONDS = 15;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
const cls = (s) => String(s ?? '').toLowerCase().replace(/[^a-z-]/g, '');
const when = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
const pct = (used, max) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);

// The answer page reloads like the file does, but never while a form is being
// filled in (a meta refresh would wipe a half-typed answer). Typing in "Other"
// picks the Other option.
const SCRIPT = `(() => {
  let dirty = false;
  addEventListener('input', (e) => {
    dirty = true;
    const other = e.target.name === 'other' && e.target.form && e.target.form.querySelector('input[value="${OTHER}"]');
    if (other) other.checked = true;
  });
  setInterval(() => {
    const a = document.activeElement;
    if (!dirty && !(a && a.form) && !document.querySelector('details[open] form')) location.reload();
  }, ${REFRESH_SECONDS * 1000});
})();`;

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

const hidden = (live, fields) => [['t', live.token], ...fields].map(([k, val]) => `<input type="hidden" name="${k}" value="${esc(val)}">`).join('');
const recommended = ' <span class="chip s-pass">Recommended</span>';

function noteForm(live, unit) {
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

function questionItem(q, live) {
  const head = `<p class="qtext">${q.header ? `<span class="chip">${esc(q.header)}</span> ` : ''}<b>${esc(q.id)}</b> ${esc(q.text)}${q.unit ? ` <span class="cause">· ${esc(q.unit)}</span>` : ''}</p>`;
  const rec = q.recommend && !q.options.length ? `<p class="rec">Recommended: ${esc(q.recommend)}</p>` : '';
  const changes = q.history.length - 1;
  const ans = q.answer ? `<p class="ans"><b>Answer:</b> ${esc(answerText(q.answer))} <span class="cause">by ${esc(q.answer.by)}, ${esc(when(q.answer.at))}${changes > 0 ? `, changed ${changes} ${changes === 1 ? 'time' : 'times'}` : ''}</span></p>` : '';
  const body = live && ['open', 'answered'].includes(q.status) ? answerForm(q, live) : optionList(q);
  return `<li class="q" id="${esc(q.id)}">${head}${rec}${ans}${body}</li>`;
}

function unitCard(u, live) {
  const link = u.link ? (href(u.link) ? ` <a href="${href(u.link)}" rel="noreferrer">link</a>` : ` <span class="cause">${esc(u.link)}</span>`) : '';
  const flag = u.attention ? `<span class="chip flag" title="${esc(u.attention)}">needs attention</span> ` : '';
  const raw = [u.gap && `<dt>Last gap</dt><dd>${esc(u.gap)}${u.cause ? ` <span class="cause">cause: ${esc(u.cause)}</span>` : ''}</dd>`, u.evidence && `<dt>Evidence</dt><dd>${esc(u.evidence)}</dd>`].filter(Boolean).join('');
  return `<section class="card" id="unit-${esc(u.id)}"><h3><span>${esc(u.title ? `${u.id} · ${u.title}` : u.id)}${link}</span><span>${flag}<span class="chip s-${cls(u.status)}">${esc(u.status)}</span></span></h3>`
    + `<p class="say">${esc(u.sentence)}</p>`
    + `<div class="row"><span>round ${u.rounds}/${u.maxRounds}${u.after ? ` · after ${esc(u.after)}` : ''}</span><span>${esc(trend(u.scores) || 'no score yet')}</span></div>`
    + bar(u.rounds, u.maxRounds)
    + (u.scores.length ? `<div class="row">${sparkline(u.scores)}</div>` : '')
    + (raw ? `<details class="raw"><summary>Gap and evidence</summary><dl>${raw}</dl></details>` : '')
    + `<div class="unit-next"><b>Next:</b> ${esc(u.next)}</div>`
    + (u.personNotes ?? []).slice(-2).map((n) => `<p class="from"><b>From you:</b> ${esc(n.text)}</p>`).join('')
    + (live ? `<details class="raw"><summary>Add a note on this unit</summary>${noteForm(live, u.id)}</details>` : '')
    + '</section>';
}

function needsYou(v, live) {
  const hint = live || !(v.needsYou.length + v.answered.length) ? ''
    : `<p class="hint">This copy is read-only. Answer in the chat, or ask the lead for the answer page (<code>run.mjs serve ${esc(v.id)}</code>).</p>`;
  const open = v.needsYou.length ? `<div class="needs"><b>Needs you</b><ul>${v.needsYou.map((q) => questionItem(q, live)).join('')}</ul>${hint}</div>`
    : `<div class="needs calm">Nothing needs you.${hint}</div>`;
  const answered = v.answered.length
    ? `<div class="needs calm"><b>Answered, waiting for the lead</b> <span class="cause">you can change these until the lead uses them</span><ul>${v.answered.map((q) => questionItem(q, live)).join('')}</ul></div>` : '';
  return open + answered;
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

export function hud(v, nowMs = Date.now(), live = null) {
  const form = live && v.open ? live : null; // a closed run takes no answers
  const parts = {
    csp: `default-src 'none'; style-src 'unsafe-inline'; img-src data:${live ? `; script-src 'nonce-${esc(live.nonce)}'; form-action 'self'; base-uri 'none'` : ''}`,
    refresh: v.open && !live ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : '',
    script: form ? `<script nonce="${esc(live.nonce)}">${SCRIPT}</script>` : '',
    noteForm: form ? noteForm(form) : '',
    id: esc(v.id), tag: esc(v.tag), phase: esc(v.phase), phaseClass: cls(v.phase.replace(/^closed: /, '')),
    started: esc(when(v.started)), updated: esc(when(new Date(nowMs).toISOString())), next: esc(v.next),
    situation: esc(v.situation.text), situationMeta: v.situation.computed ? 'counted from the state' : esc(`the lead, ${when(v.situation.at)}`),
    needs: needsYou(v, form), timeLeft: esc(v.timeLeft),
    goal: esc(v.goal), bar: esc(v.bar), fence: esc(v.fence),
    budget: v.budget.map((b) => `<div class="card"><div class="row" style="margin:0"><span>${esc(b.name)}</span><b>${b.used}/${b.max}${b.unit ? ` ${esc(b.unit)}` : ''}</b></div>${bar(b.used, b.max)}</div>`).join(''),
    units: v.units.length ? v.units.map((u) => unitCard(u, form)).join('') : '<p class="empty">No units yet.</p>',
    integration: v.integration.length ? `<h2>Integration</h2><p>${v.integration.map((r) => `<span class="chip s-${cls(r)}">${esc(r)}</span>`).join(' → ')}</p>` : '',
    lists: [list('Decisions', v.decisions), list('Questions', v.questions), list('Follow-ups', v.followUps),
      list('Notes from you', v.personNotes.map((n) => `${n.unit ? `${n.unit}: ` : ''}${n.text}`))].join(''),
    timeline: v.timeline.length ? v.timeline.slice(0, 60).map(event).join('') : '<li class="empty">Nothing yet.</li>',
  };
  // One pass: text inserted for one placeholder is never scanned for another.
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k) => parts[k] ?? '');
}
