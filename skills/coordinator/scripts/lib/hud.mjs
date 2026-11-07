// The dashboard: the fixed shell (hud.template.html, via lib/parts.mjs) filled
// from a view (lib/view.mjs), so every run looks the same. State text is
// untrusted: it is escaped, and only http(s) URLs and #refs become links.
// Without `ctx.live` it is the static hud.html: no scripts, no network, a
// read-only snapshot. With it (lib/serve.mjs) it is the live dashboard: forms,
// and one script, allowed by a per-response nonce, that patches blocks in place.
import { linkName } from './chain.mjs';
import { modelLine } from './models.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchor, linkify, shortRef, webUrl } from './links.mjs';
import { answerText, OTHER } from './questions.mjs';
import { badge, behaviourList, blk, blocksLine, chip, cls, dot, esc, linkWaits, stateChip, unitDot, eventRow, evidenceList, hash, keyed, page, stamp, timelineTools, toggle } from './parts.mjs';
import { clip } from './plain.mjs';
import { viewer, viewerEntries } from './evview.mjs';
import { readStored, storedPath } from './evidence.mjs';
import { escapeLine } from './view.mjs';
import { pendingBanner } from './retro.mjs';

export { esc };
const pct = (used, max) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);
const TIMELINE_MAX = 300;
const EMBED_MAX = 150 * 1024;

// How pages reach units and artifacts: on disk (relative files) or served (token in the URL).
export function staticCtx(runDir, depth = 0, theme = null) {
  const up = '../'.repeat(depth);
  return {
    live: null, theme, run: null, artifacts: !!runDir, home: `${up}hud.html`, maps: `${up}maps.html`, report: `${up}report.html`, retro: `${up}retro.html`, pages: [],
    runHref: (id) => `${up}../${encodeURIComponent(id)}/hud.html`,
    mapHref: runDir && existsSync(join(runDir, 'map.html')) ? `${up}map.html` : null,
    unitHref: (id) => `${up}units/${encodeURIComponent(id)}.html`,
    artHref: (file) => `${up}artifacts/${file.split('/').map(encodeURIComponent).join('/')}`,
    // Every read goes through storedPath: the state's file names are checked, links never followed.
    has: (file) => !runDir || storedPath(runDir, file) !== null,
    // A stored text file's words, for the viewer (lib/evview.mjs caps them).
    readText: (file) => readStored(runDir, file, 'utf8'),
    // Small screenshots go inline, so the snapshot shows them without loading anything.
    embed: (file) => {
      if (!runDir) return null;
      const b = readStored(runDir, file);
      return b && b.length <= EMBED_MAX ? `data:${mime(file)};base64,${b.toString('base64')}` : null;
    },
  };
}
const mime = (f) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[f.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

// `other`: another run of the same state folder, shown read-only under /run/<id>.
export function liveCtx({ token, nonce }, run, theme = null, other = null) {
  const t = `t=${encodeURIComponent(token)}`;
  const base = other ? `/run/${encodeURIComponent(other)}` : '';
  return {
    live: { token, nonce }, theme, run, store: other ?? run, base, home: base ? `${base}?${t}` : `/?${t}`, embed: null, readOnly: !!other,
    maps: `${base}/maps?${t}`, report: `${base}/report?${t}`, retro: `${base}/retro?${t}`,
    unitHref: (id) => `${base}/unit/${encodeURIComponent(id)}?${t}`,
    artHref: (file) => `${base}/artifacts/${file.split('/').map(encodeURIComponent).join('/')}?${t}`,
    runHref: (id) => (id === run ? `/?${t}` : `/run/${encodeURIComponent(id)}?${t}`),
    // The header's page links; a new page adds itself here and to lib/serve.mjs PAGE.
    // On another run's pages they name and link that run, not the served one.
    pages: [{ path: base || '/', label: other ?? run ?? 'Run', href: base ? `${base}?${t}` : `/?${t}` }, { path: `${base}/maps`, label: 'Maps', href: `${base}/maps?${t}` }, { path: `${base}/report`, label: 'Report', href: `${base}/report?${t}` }, { path: `${base}/retro`, label: 'Retro', href: `${base}/retro?${t}` }, { path: '/coordinator', label: 'Coordinator', href: `/coordinator?${t}` }],
  };
}

// tone: 'hot' when a limit is blocking work, 'calm' when a full bar is simply done.
function bar(used, max, tone = '', title = '') {
  const p = pct(used, max);
  return `<div class="bar"${title ? ` title="${esc(title)}"` : ''}><i class="${tone}" style="width:${p}%"></i></div>`;
}

// What one try came to, for a dot's tooltip and screen readers.
const tryLabel = (r) => `Try ${r.n}: ${r.verdict === 'pass' ? 'passed' : 'failed'}${typeof r.score === 'number' ? `, ${r.score}/10` : ''}${r.verdict === 'pass' ? '' : (r.cause || r.gap) ? ` — ${clip(r.cause || r.gap, 70)}` : ''}`;

// Scores per try on a 0-10 scale, one focusable dot per try coloured by verdict.
// One try reads better as words than as a lone dot.
export function scoreChart(rounds) {
  if (!rounds.length) return '';
  const last = rounds.at(-1);
  if (rounds.length === 1) return `<p class="cause score-one">${esc(last.verdict === 'pass' ? 'Passed on try 1' : 'Failed try 1')}${typeof last.score === 'number' ? ` (${last.score}/10)` : ''}${last.verdict !== 'pass' && (last.cause || last.gap) ? ` — ${esc(clip(last.cause || last.gap, 70))}` : ''}</p>`;
  const W = 120; const H = 32; const pad = 5;
  const x = (i) => pad + (i * (W - 2 * pad)) / (rounds.length - 1);
  const y = (sc) => H - pad - (sc / 10) * (H - 2 * pad);
  const pts = rounds.map((r, i) => (typeof r.score === 'number' ? [x(i), y(r.score), r] : null)).filter(Boolean);
  const line = pts.length > 1 ? `<polyline points="${pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')}"/>` : '';
  const dots = pts.map(([a, b, r]) => `<circle class="${r.verdict === 'pass' ? 'p' : 'f'}" cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="3.5" tabindex="0" role="img" aria-label="${esc(tryLabel(r))}"><title>${esc(tryLabel(r))}</title></circle>`).join('');
  return `<div class="spark-row"><span class="cause">Score per try (0–10)</span><svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Score per try (0–10)">${line}${dots}</svg>`
    + `<span class="cause">last ${typeof last.score === 'number' ? `${last.score}/10` : '–'}</span></div>`;
}

const BUDGET_HELP = {
  time: 'Time used of the run’s time budget. When it runs out, every unit stops.',
  units: 'Units planned, against the cap. A full bar is normal: every planned unit exists.',
  'added after freeze': 'Units added after the plan was frozen, against the cap on scope creep.',
  'integration rounds': 'Integration checks used, against the cap.',
};

// A form object: the live page's { token } (field `t`, posts to /answer and /note), or a hosted
// copy's { token, tokenName, post: path prefix, disabled: why this viewer cannot write }.
const hidden = (live, fields) => [[live.tokenName ?? 't', live.token], ...(live.back ? [['back', live.back]] : []), ...fields].map(([k, val]) => `<input type="hidden" name="${k}" value="${esc(val)}">`).join('');
const recommended = ' <span class="chip s-pass">Recommended</span>';
const action = (live, path) => esc(`${live.post ?? ''}${path}`);
const off = (live) => (live.disabled ? ' disabled' : '');
const why = (live) => (live.disabled ? `<p class="hint">${esc(live.disabled)}</p>` : '');

export function noteForm(live, unit) {
  return `<form class="note" method="post" action="${action(live, '/note')}">${hidden(live, unit ? [['unit', unit]] : [])}`
    + `<label>${esc(unit ? `Note to the lead about ${unit}` : 'Note to the lead')}<textarea name="text" rows="2" maxlength="1000" required${off(live)}></textarea></label>`
    + `<button type="submit"${off(live)}>Send note</button>${why(live)}</form>`;
}

function answerForm(q, live) {
  const a = q.answer; const type = q.multi ? 'checkbox' : 'radio';
  const opts = q.options.map((o, i) => `<label class="opt"><input type="${type}" name="choice" value="${esc(o.label)}"${a?.choices.includes(o.label) ? ' checked' : ''}>`
    + `<span><b>${esc(o.label)}${i === 0 ? recommended : ''}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('');
  const box = `<input type="text" name="other" maxlength="1000" value="${esc(a?.other ?? '')}" placeholder="Your own answer" aria-label="Other answer for ${esc(q.id)}"${q.options.length ? '' : ' required'}>`;
  const other = !q.options.length ? `<label class="opt"><span><b>Your answer</b>${box}</span></label>`
    : q.multi ? `<label class="opt"><span><b>Other</b><small>optional, as well as any options above</small>${box}</span></label>`
      : `<label class="opt"><input type="radio" name="choice" value="${OTHER}"${a?.other ? ' checked' : ''}><span><b>Other</b>${box}</span></label>`;
  return `<form class="ask" method="post" action="${action(live, '/answer')}">${hidden(live, [['q', q.id]])}`
    + `<fieldset${off(live)}><legend>${q.options.length ? (q.multi ? 'Pick any' : 'Pick one') : 'Write your answer'}</legend>${opts}${other}</fieldset>`
    + `<button type="submit"${off(live)}>${a ? 'Change answer' : 'Submit'}</button>${why(live)}</form>`;
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
  return `<li class="q" id="${esc(q.id)}" data-a="q-${esc(q.id)}">${head}${rec}${ans}${body}</li>`;
}

// The unit's own links (--link at add, then each `run.mjs link`), http(s) only.
export function unitLinks(u, repo) {
  const all = [...(u.link ? [{ kind: 'link', url: u.link }] : []), ...u.links];
  if (!all.length) return '';
  const one = (l) => (webUrl(l.url) ? anchor(webUrl(l.url), shortRef(webUrl(l.url), repo)) : esc(l.url));
  return `<div class="links">${all.map((l) => `<span>${badge(l.kind === 'merge' ? 'merge' : 'link', l.kind)} ${one(l)}${l.label ? ` ${esc(l.label)}` : ''}</span>`).join('')}</div>`;
}

// "Tries used: 2 of 4", with what a try is on hover. Full on a finished unit is calm, not alarming.
export function triesRow(u) {
  const help = `Each try is one build plus one independent review; the unit stops after ${u.maxRounds}.`;
  const tone = u.finished ? 'calm' : pct(u.rounds, u.maxRounds) >= 75 ? 'hot' : '';
  return `<div class="row" title="${esc(help)}"><span>Tries used: ${u.rounds} of ${u.maxRounds}${u.after ? ` · after ${esc(u.after)}` : ''}</span></div>${bar(u.rounds, u.maxRounds, tone, help)}`;
}

// The same work in other runs (#36): "Continues run-a (3 tries, stopped) · Continued in run-b: pass".
export function chainRow(u, ctx) {
  const c = u.chain;
  if (!c) return '';
  const name = (l) => { const t = esc(linkName(l, u.id)); return l.known && ctx?.runHref ? `<a href="${esc(ctx.runHref(l.run))}">${t}</a>` : t; };
  const one = (l) => `${name(l)} <span class="cause">(${l.known ? `${l.rounds.length} ${l.rounds.length === 1 ? 'try' : 'tries'}, ${esc(l.outcome)}` : 'not here'})</span>`;
  const parts = [c.before.length && `Continues ${c.before.map(one).join(' → ')}`, c.after.length && `Continued in ${c.after.map(one).join(' → ')}`].filter(Boolean);
  return `<p class="cause chain" data-a="chain-${esc(u.id)}">${parts.join(' · ')}${c.after.length ? ` · finally ${chip(c.final.outcome ?? 'unknown', c.final.outcome ?? '')}` : ''}</p>`;
}

function unitCard(u, ctx, form, repo) {
  const raw = [u.gap && `<dt>Last gap</dt><dd>${linkify(u.gap, repo)}${u.cause ? ` <span class="cause">cause: ${esc(u.cause)}</span>` : ''}</dd>`, u.evidence && `<dt>Evidence</dt><dd>${linkify(u.evidence, repo)}</dd>`].filter(Boolean).join('');
  const passing = u.behaviours.filter((b) => b.status === 'pass').length;
  const waits = u.dependsOn.map((x) => x.id);
  const html = `<h3><span>${unitDot(u)} ${esc(u.title ? `${u.id} · ${u.title}` : u.id)}</span><span>${stateChip(u, ctx)}</span></h3>`
    + unitLinks(u, repo)
    + `<p class="say" data-a="say-${esc(u.id)}">${linkWaits(u.sentence, waits, ctx)}</p>`
    + blocksLine(u, ctx)
    + triesRow(u)
    + chainRow(u, ctx)
    + (u.who ? `<p class="cause" data-a="who-${esc(u.id)}">${esc(u.who)}</p>` : '')
    + scoreChart(u.roundList)
    + (u.behaviours.length ? toggle(`u-${u.id}-beh`, `Behaviours · ${passing}/${u.behaviours.length} pass`, behaviourList(u.behaviours, repo, [], null, `u-${u.id}`)) : '')
    + (u.evidenceItems.length ? toggle(`u-${u.id}-ev`, `Evidence · ${u.evidenceItems.length}`, evidenceList(u.evidenceItems, repo, ctx, `u-${u.id}-ev`)) : '')
    + (raw ? toggle(`u-${u.id}-raw`, 'Gap and evidence', `<dl>${raw}</dl>`) : '')
    + `<div class="unit-next" data-a="next-${esc(u.id)}"><b>Next:</b> ${linkWaits(u.next, waits, ctx)}</div>`
    + u.personNotes.slice(-2).map((n) => `<p class="from" data-a="from-${esc(u.id)}-${esc(n.at)}"><b>From you:</b> ${linkify(n.text, repo)}</p>`).join('')
    + (form ? toggle(`u-${u.id}-note`, 'Add a note on this unit', noteForm(form, u.id)) : '')
    + `<div class="row" data-a="open-${esc(u.id)}"><a class="open" href="${esc(ctx.unitHref(u.id))}">Open ${esc(u.id)} →</a></div>`;
  return blk(`unit-${u.id}`, html, 'section', ` class="card${u.finished ? ' fin' : ''}" id="unit-${esc(u.id)}"`);
}

// ctx.readOnlyHint (plain text): where a read-only copy tells people to answer instead.
function needsYou(v, form, ctx = {}) {
  const hint = form || !(v.needsYou.length + v.answered.length) ? ''
    : ctx.readOnlyHint ? `<p class="hint">${esc(ctx.readOnlyHint)}</p>`
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
  const body = items.length ? `<ul>${keyed(items, (t) => `l-${title}-${hash(t)}`).map(([t, k]) => `<li data-a="${k}">${linkify(t, repo)}</li>`).join('')}</ul>` : '<p class="empty">None.</p>';
  return `<section class="card" data-a="list-${esc(title)}"><h3>${esc(title)} <span class="chip">${items.length}</span></h3>${body}</section>`;
}

// Open questions only, counted; answered ones in a dimmed, collapsed group with the answer first.
function questionsCard(v, repo) {
  const open = v.questions.length ? `<ul>${keyed(v.questions, (t) => `l-Questions-${hash(t)}`).map(([t, k]) => `<li data-a="${k}">${linkify(t, repo)}</li>`).join('')}</ul>` : '<p class="empty">None open.</p>';
  const done = v.answeredQuestions.map((q) => `<li data-a="aq-${esc(q.id)}"><b>${esc(q.id)}</b> ${esc(q.title)}`
    + `<p class="ans"><b>Answered:</b> ${linkify(q.answer, repo)} <span class="cause">— by ${q.by === 'person' ? 'you' : esc(q.by)}${q.at ? `, ${stamp(q.at)}` : ''}</span></p>`
    + `${q.decision ? `<p class="cause">Decision: ${linkify(q.decision, repo)}</p>` : ''}</li>`).join('');
  return `<section class="card" data-a="list-Questions"><h3>Questions <span class="chip" title="open questions">${v.questions.length}</span></h3>${open}`
    + (done ? toggle('answered-questions', `Answered · ${v.answeredQuestions.length}`, `<ul class="answered">${done}</ul>`) : '') + '</section>';
}

export function timelineList(events, repo, finished = new Set(), ctx = null) {
  // Each row's key holds its time, kind, who, a hash of its text, and a number if two still match.
  return events.length ? keyed(events.slice(0, TIMELINE_MAX), (e) => `ev|${e.at}|${e.label}|${e.who}|${hash(`${e.text}|${e.cause ?? ''}|${e.score ?? ''}`)}`).map(([e, k]) => eventRow(e, repo, k, finished.has(e.unit), ctx)).join('') : '<li class="empty">Nothing yet.</li>';
}

export function hud(v, nowMs = Date.now(), ctx = null) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id); // older callers pass { token, nonce }
  const live = ctx.form ?? ctx.live; // ctx.form: a hosted copy's forms (no live script)
  const form = live && v.open && !ctx.readOnly ? live : null; // a closed run, or another run's page, takes no answers
  const r = v.repo;
  const body = [
    blk('head', `<header class="run"><h1>${esc(v.id)}</h1>${chip(v.phase, cls(v.phase.replace(/^closed: /, '')))}<span class="meta">${esc(v.tag)} · started ${stamp(v.started)} · updated ${stamp(new Date(nowMs).toISOString())}</span>${ctx.maps && !ctx.pages?.length ? `<a class="open" href="${esc(ctx.maps)}">Maps →</a>` : ''}${ctx.mapHref ? `<a class="open" href="${esc(ctx.mapHref)}">Project map →</a>` : ''}${ctx.report && !ctx.pages?.length ? `<a class="open" style="margin-left:14px" href="${esc(ctx.report)}">Report →</a>` : ''}${ctx.retro && !ctx.pages?.length ? `<a class="open" style="margin-left:14px" href="${esc(ctx.retro)}">Retro →</a>` : ''}</header>`),
    blk('situation', `<div class="situation"><p>${linkify(v.situation.text, r)}</p><p class="meta">Situation · ${v.situation.computed ? 'counted from the state' : `the lead, ${stamp(v.situation.at)}`}</p></div>`),
    v.retroPending ? blk('retro-pending', pendingBanner(v, !v.open)) : '',
    blk('goal', goalBlock(v, ctx)),
    blk('needs', needsYou(v, form, ctx)),
    form ? blk('note', noteForm(form)) : '',
    blk('eta', `<div class="eta"><b>Time left</b>${esc(v.timeLeft)}</div><div class="next"><b>Next</b>${esc(v.next)}</div>`),
    blk('gbf', toggle('gbf', 'Goal, bar and fence', `<dl><dt>Goal</dt><dd>${linkify(v.goal, r)}</dd><dt>Bar</dt><dd>${linkify(v.bar, r)}</dd><dt>Fence</dt><dd>${linkify(v.fence, r)}</dd></dl>`, '')),
    '<h2 data-a="h-Budget">Budget</h2>',
    blk('budget', v.budget.map((b) => `<div class="card" data-a="budget-${esc(b.name)}" title="${esc(BUDGET_HELP[b.name] ?? '')}"><div class="row" style="margin:0"><span>${esc(b.name)}</span><b>${b.used}/${b.max}${b.unit ? ` ${esc(b.unit)}` : ''}</b></div>${bar(b.used, b.max, b.name !== 'units' && pct(b.used, b.max) >= 90 ? 'hot' : '', BUDGET_HELP[b.name])}</div>`).join('') + escapeCard(v.escapes) + modelCard(v.models, v.modelsUnrecorded), 'div', ' class="budget"'),
    '<h2 data-a="h-Units">Units</h2>',
    `<p class="legend"><label class="fchip"><input type="checkbox" id="show-finished" checked><span>Show finished</span></label> <span class="key">${dot('needs-you')} <b>Needs you</b> = only you can unblock it;</span> <span class="key">${dot('blocked')} <b>Waiting for A</b> = blocked on another unit (A);</span> <span class="key">${dot('queued')} <b>Up next</b> = ready, not started;</span> <span class="key">${dot('working')} working;</span> <span class="key">${dot('retrying')} <b>Retrying</b> = the lead is on it;</span> <span class="key">${dot('stale')} <b>Quiet</b> = the lead is checking on a silent agent;</span> <span class="key">${dot('passed')} passed;</span> <span class="key">${dot('stopped')} stopped.</span> Score dots: red = failed try, green = passed try.</p>`,
    blk('units', v.units.length ? [...v.units.filter((u) => !u.finished), ...v.units.filter((u) => u.finished)].map((u) => unitCard(u, ctx, form, r)).join('') : '<p class="empty">No units yet.</p>', 'div', ' class="grid"'),
    blk('integration', v.integration.length ? `<h2>Integration</h2><p>${v.integration.map((x) => chip(x, x)).join(' → ')}</p>` : ''),
    '<h2 data-a="h-Decisions">Decisions, questions and follow-ups</h2>',
    blk('lists', [list('Decisions', v.decisions, r), questionsCard(v, r), list('Follow-ups', v.followUps, r),
      list('Notes from you', v.personNotes.map((n) => `${n.unit ? `${n.unit}: ` : ''}${n.text}`), r)].join(''), 'div', ' class="lists"'),
    '<h2 id="timeline" data-a="h-timeline">Timeline</h2>',
    ctx.live ? timelineTools(v.units.map((u) => u.id)) : '',
    blk('timeline', timelineList(v.timeline, r, new Set(v.units.filter((u) => u.finished).map((u) => u.id)), ctx), 'ol', ' class="timeline" data-tl-list data-ev-list'),
    blk('evv', viewer(viewerEntries(v), ctx, r)),
  ].join('\n');
  return page({ title: v.id, body, ctx, path: ctx.base || '/', closed: !v.open });
}


// Builder models: rounds and pass rate each, so a cheaper builder that fails more shows up.
function modelCard(m, none = 0) {
  if (!m?.length && !none) return '';
  return `<div class="card" data-a="budget-models" title="Rounds built on each model, and how many the critic passed"><div class="row" style="margin:0"><span>builder models</span><b>${esc(modelLine(m ?? [], none))}</b></div></div>`;
}

// Escapes: defects found after a unit passed, from note --kind escape. Shown once there is a pass.
function escapeCard(e) {
  if (!e || (!e.passed && !e.escapes)) return '';
  const items = e.list.map((x) => `<li>${esc(x.unit)}${x.round ? ` (passed in try ${x.round})` : ''}: ${esc(clip(x.text, 160))}</li>`).join('');
  return `<div class="card" data-a="budget-escapes" title="Defects found after a unit passed: in a later review, in verify, on test or by a person"><div class="row" style="margin:0"><span>escapes</span><b>${esc(escapeLine(e))}</b></div>${items ? `<ul>${items}</ul>` : ''}</div>`;
}
