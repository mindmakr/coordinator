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
import { badge, behaviourList, blk, blocksLine, chip, cls, cols, dot, esc, grows, heading, kpis, linkWaits, panel, stateChip, table, toneChip, tries, unitDot, unitLink, eventRow, evidenceList, hash, keyed, page, stamp, timelineTools, toggle } from './parts.mjs';
import { clip } from './plain.mjs';
import { viewer, viewerEntries } from './evview.mjs';
import { readStored, storedPath } from './evidence.mjs';
import { escapeLine } from './view.mjs';
import { pendingBanner } from './retro.mjs';

export { esc };

// Where the run came from (lib/harness.mjs): the tool and skill version that started it, the name
// the person uses for it, and a warning when another version of the skill last wrote it.
export function originLine(o) {
  const alias = o.alias ? `<b>${esc(o.alias)}</b> · ` : '';
  return `<p class="meta origin">${alias}${esc(o.line)}${o.later ? ` · ${esc(o.later)}` : ''}</p>`
    + (o.warning ? `<p class="hint origin-warn" role="note">${badge('stop', 'version')} ${esc(o.warning)}</p>` : '');
}

// The run's status word as a chip, coloured by kind (lib/progress.mjs runStatus).
const STATUS_CLS = { running: 's-working', paused: 's-needs-you', waiting: 's-needs-you', finishing: 's-finishing' };
export const statusChip = (st) => chip(st.word, st.concluded ? cls(st.outcome) : STATUS_CLS[st.kind]);
// Units done out of total as a compact bar with its words; a screen reader hears the words.
export function progressBar(st, small = false) {
  return `<div class="bar progress${small ? ' small' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct}" aria-label="${esc(st.progress)}"><i class="${st.concluded ? 'calm' : ''}" style="width:${st.pct}%"></i></div>`;
}
// Where the Gaps list is: the coordinator page when served (static snapshots name it).
const gapsHref = (ctx) => { const c = ctx?.pages?.find((p) => p.path === '/coordinator'); return c ? `${c.href}#self-gaps` : null; };

// The header's status: running runs say how far and how long; a concluded run says it is finished and what it delivered.
export function statusBlock(st, ctx = null) {
  if (st.concluded) {
    const g = gapsHref(ctx);
    const gaps = `${st.followUps} ${st.followUps === 1 ? 'follow-up' : 'follow-ups'} in ${g ? `<a href="${esc(g)}">Gaps</a>` : 'Gaps'}`;
    return `<section class="status concluded out-${esc(st.outcome)}" aria-label="Run status"><p class="status-head"><b>This run is finished.</b> ${esc(st.reason[0].toUpperCase() + st.reason.slice(1))}.</p>`
      + `<p><b>Delivered:</b> ${st.delivered.length ? st.delivered.map(esc).join('; ') : 'nothing'}</p>`
      + `<p class="meta">${esc(st.progress)} · ${gaps} · closed ${stamp(st.closedAt)}</p>${progressBar(st)}</section>`;
  }
  const needs = st.needsYou.length ? ` · <b>needs you:</b> ${st.needsYou.map((q) => esc(q.id)).join(', ')}` : '';
  return `<section class="status s-kind-${esc(st.kind)}" aria-label="Run status"><p class="status-head"><b>${esc(st.progress)}</b> · ${esc(st.doing)}${needs}</p>`
    + `${progressBar(st)}<p class="meta">${esc(st.eta.text[0].toUpperCase() + st.eta.text.slice(1))}.</p></section>`;
}
const pct = (used, max) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);
// The line above a question that names its project, run and task (lib/questions.mjs questionLabel).
export const qLabel = (q) => (q.label ? `<p class="qlabel" title="Which run and task this question comes from">${esc(q.label)}</p>` : '');
const TIMELINE_MAX = 300;
const EMBED_MAX = 150 * 1024;

// How pages reach units and artifacts: on disk (relative files) or served (token in the URL).
export function staticCtx(runDir, depth = 0, theme = null) {
  const up = '../'.repeat(depth);
  return {
    live: null, theme, run: null, artifacts: !!runDir, home: `${up}hud.html`, maps: `${up}maps.html`, report: `${up}report.html`, retro: `${up}retro.html`,
    // The run's tabs, as files beside hud.html (the Project map only when one is built).
    pages: runTabs({ base: '', href: (p) => `${up}${{ '': 'hud', '/maps': 'maps', '/report': 'report', '/retro': 'retro' }[p]}.html`, map: runDir && existsSync(join(runDir, 'map.html')) ? `${up}map.html` : null }),
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
    // The coordinator's page is a tab only on itself; the run's pages reach it from the breadcrumb (This PC).
    pages: [...runTabs({ base, href: (p) => `${base}${p}${p || base ? '' : '/'}?${t}`, map: `${base}/map?${t}` }), { path: '/coordinator', label: 'Coordinator', href: `/coordinator?${t}`, tab: false }],
    pc: { label: 'This PC', href: `/coordinator?${t}#self-pc` },
  };
}

// The run's tab row (Overview, Units, Maps, Report, Retro, Project map): href(p) is where the page at
// sub-path p ('' for the run itself) lives; map is the project map's href, or null when there is none.
// Units is current on every unit page and leads to the Units table.
export function runTabs({ base = '', href, map = null }) {
  return [
    { path: base || '/', label: 'Overview', href: href('') },
    { path: `${base}/unit`, prefix: `${base}/unit/`, label: 'Units', href: `${href('')}#unit-list` },
    { path: `${base}/maps`, label: 'Maps', href: href('/maps') },
    { path: `${base}/report`, label: 'Report', href: href('/report') },
    { path: `${base}/retro`, label: 'Retro', href: href('/retro') },
    ...(map ? [{ path: `${base}/map`, label: 'Project map', href: map }] : []),
  ];
}

// tone: 'hot' when a limit is blocking work, 'calm' when a full bar is simply done.
function bar(used, max, tone = '', title = '') {
  const p = pct(used, max);
  return `<div class="bar"${title ? ` title="${esc(title)}"` : ''}><i class="${tone}" style="width:${p}%"></i></div>`;
}

// What one try came to, for a dot's tooltip and screen readers.
const tryLabel = (r) => `Try ${r.n}: ${r.verdict === 'pass' ? 'passed' : r.failedBy?.length ? `failed by specialist ${r.failedBy.join(', ')}` : 'failed'}${typeof r.score === 'number' ? `, ${r.score}/10` : ''}${r.verdict === 'pass' ? '' : (r.cause || r.gap) ? ` — ${clip(r.cause || r.gap, 70)}` : ''}`;

// Scores per try on a 0-10 scale, one focusable dot per try coloured by verdict.
// One try reads better as words than as a lone dot.
export function scoreChart(rounds) {
  if (!rounds.length) return '';
  const last = rounds.at(-1);
  if (rounds.length === 1) return `<p class="cause score-one">${esc(last.verdict === 'pass' ? 'Passed on try 1' : `Failed try 1${last.failedBy?.length ? ` by specialist ${last.failedBy.join(', ')}` : ''}`)}${typeof last.score === 'number' ? ` (${last.score}/10)` : ''}${last.verdict !== 'pass' && (last.cause || last.gap) ? ` — ${esc(clip(last.cause || last.gap, 70))}` : ''}</p>`;
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
// live.fields: more hidden fields every form carries (the PC dashboard's project key and run id).
const hidden = (live, fields) => [[live.tokenName ?? 't', live.token], ...(live.back ? [['back', live.back]] : []), ...(live.fields ?? []), ...fields].map(([k, val]) => `<input type="hidden" name="${k}" value="${esc(val)}">`).join('');
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

// prefix: keeps ids unique on a page that lists the questions of several runs (the PC dashboard).
export function questionItem(q, live, repo = null, prefix = '') {
  const head = `<p class="qtext">${q.header ? `<span class="chip">${esc(q.header)}</span> ` : ''}<b>${esc(q.id)}</b> ${linkify(q.text, repo)}${q.unit ? ` <span class="cause">· ${esc(q.unit)}</span>` : ''}</p>`;
  const rec = q.recommend && !q.options.length ? `<p class="rec">Recommended: ${esc(q.recommend)}</p>` : '';
  const changes = q.history.length - 1;
  const ans = q.answer ? `<p class="ans"><b>Answer:</b> ${esc(answerText(q.answer))} <span class="cause">by ${esc(q.answer.by)}, ${stamp(q.answer.at)}${changes > 0 ? `, changed ${changes} ${changes === 1 ? 'time' : 'times'}` : ''}</span></p>` : '';
  const body = live && ['open', 'answered'].includes(q.status) ? answerForm(q, live) : optionList(q);
  return `<li class="q" id="${esc(prefix + q.id)}" data-a="q-${esc(prefix + q.id)}">${qLabel(q)}${head}${rec}${ans}${body}</li>`;
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

// One mark per try (lib/ui.mjs tries): passed or failed rounds, the try a builder or critic is on, the
// next try when it is queued, then the tries still unused up to the unit's cap.
export function tryStates(u) {
  const working = !u.finished && ['building', 'judging'].includes(u.status);
  const s = u.roundList.map((r) => (r.verdict === 'pass' ? 'pass' : 'fail'));
  if (working) s.push('work');
  else if (!u.finished && ['queued', 'retrying'].includes(u.dot) && s.length < u.maxRounds) s.push('queued');
  while (s.length < u.maxRounds) s.push('open');
  return s;
}
// "try 3 of 4 in progress", "try 2 of 4 next", "2 of 4 tries used".
export function tryText(u) {
  if (!u.finished && ['building', 'judging'].includes(u.status)) return `try ${u.rounds + 1} of ${u.maxRounds} in progress`;
  if (!u.finished && ['queued', 'retrying'].includes(u.dot) && u.rounds < u.maxRounds) return `try ${u.rounds + 1} of ${u.maxRounds} next`;
  return `${u.rounds} of ${u.maxRounds} ${u.maxRounds === 1 ? 'try' : 'tries'} used`;
}
// Scores per try as a trend: "7 → 4 → 5"; a try without a score is "–".
export const scoreTrend = (u) => u.scores.map((s) => (typeof s.score === 'number' ? s.score : '–')).join(' → ');

// The last gap and the evidence that goes with it (lib/view.mjs gapEvidence: a specialist's own when it
// failed the round, #147), with who gave it. Empty once the unit passed.
export function lastGapHtml(u, repo, short = true) {
  if (!u.gap) return '';
  const last = u.roundList.at(-1);
  const by = u.failedBy ? toneChip(`specialist ${u.failedBy.specialists.join(', ')}`, 'bad') : '';
  const cut = (t) => (short ? clip(t, 220) : t);
  return `${by ? `<p class="by">${by}${last ? ` <span class="cause">try ${esc(last.n)}</span>` : ''}</p>` : ''}<p class="gap">${linkify(cut(u.gap), repo)}</p>`
    + (u.cause ? `<p class="cause">cause: ${esc(u.cause)}</p>` : '')
    + (u.evidence ? `<p class="cause gev"><b>Evidence${u.failedBy ? ` (${esc(u.failedBy.specialists.join(', '))})` : ''}:</b> ${linkify(cut(u.evidence), repo)}</p>` : '');
}

// One row of the Units table: the unit (linked) with its sentence, what it blocks and its links; its state;
// its try marks; its scores; its last gap; its next step.
function unitRow(u, ctx, repo) {
  const waits = u.dependsOn.map((x) => x.id);
  const passing = u.behaviours.filter((b) => b.status === 'pass').length;
  const name = `<a class="mono uid" href="${esc(ctx.unitHref(u.id))}">${esc(u.id)}</a>${u.title ? ` <b>${esc(u.title)}</b>` : ''}`;
  const unit = `<div class="ucell">${unitDot(u)} ${name}</div><p class="say cause" data-a="say-${esc(u.id)}">${linkWaits(u.sentence, waits, ctx)}</p>`
    + blocksLine(u, ctx) + unitLinks(u, repo) + chainRow(u, ctx) + (u.who ? `<p class="cause" data-a="who-${esc(u.id)}">${esc(u.who)}</p>` : '')
    + u.personNotes.slice(-2).map((n) => `<p class="from" data-a="from-${esc(u.id)}-${esc(n.at)}"><b>From you:</b> ${linkify(n.text, repo)}</p>`).join('');
  const state = `${stateChip(u, ctx)}${u.behaviours.length ? `<p class="cause">behaviours ${passing}/${u.behaviours.length}</p>` : ''}`;
  const tried = `${tries(tryStates(u))}<p class="cause">${esc(tryText(u))}</p>`;
  return {
    id: `unit-${u.id}`, key: `row-${u.id}`, cls: u.finished ? 'fin' : '',
    cells: [{ html: unit }, { html: state }, { html: tried }, { html: `<span class="mono">${esc(scoreTrend(u) || '–')}</span>` },
      { html: `<div class="gapcell" data-a="gap-${esc(u.id)}">${lastGapHtml(u, repo) || '<span class="cause">–</span>'}</div>` },
      { html: `<div data-a="next-${esc(u.id)}">${linkWaits(u.next, waits, ctx)}</div>` }],
  };
}

const LEGEND = `<p class="legend"><label class="fchip"><input type="checkbox" id="show-finished" checked><span>Show finished</span></label> <span class="key">${dot('needs-you')} <b>Needs you</b> = only you can unblock it;</span> <span class="key">${dot('blocked')} <b>Waiting for A</b> = blocked on another unit (A);</span> <span class="key">${dot('queued')} <b>Up next</b> = ready, not started;</span> <span class="key">${dot('working')} working;</span> <span class="key">${dot('retrying')} <b>Retrying</b> = the lead is on it;</span> <span class="key">${dot('stale')} <b>Quiet</b> = the lead is checking on a silent agent;</span> <span class="key">${dot('passed')} passed;</span> <span class="key">${dot('stopped')} stopped.</span> Try marks: ✓ passed, ✕ failed, … in progress.</p>`;

function unitsPanel(v, ctx, repo) {
  const list = [...v.units.filter((u) => !u.finished), ...v.units.filter((u) => u.finished)];
  const cols = ['Unit', 'State', 'Tries', 'Scores', 'Last gap', 'Next'].map((label) => ({ label }));
  return panel({ id: 'units', title: 'Units', count: v.units.length, bodyHtml: (v.units.length ? LEGEND : '') + table({ cols, rows: list.map((u) => unitRow(u, ctx, repo)), min: 860, max: 560, empty: 'No units yet.' }) });
}

// Each unit's behaviours, evidence and note box, as the toggles the unit cards had; the unit page has them in full.
function detailsPanel(v, ctx, form, repo) {
  const one = (u) => {
    const passing = u.behaviours.filter((b) => b.status === 'pass').length;
    const parts = (u.behaviours.length ? toggle(`u-${u.id}-beh`, `Behaviours · ${passing}/${u.behaviours.length} pass`, behaviourList(u.behaviours, repo, [], null, `u-${u.id}`)) : '')
      + (u.evidenceItems.length ? toggle(`u-${u.id}-ev`, `Evidence · ${u.evidenceItems.length}`, evidenceList(u.evidenceItems, repo, ctx, `u-${u.id}-ev`)) : '')
      + (form ? toggle(`u-${u.id}-note`, 'Add a note on this unit', noteForm(form, u.id)) : '');
    return parts ? `<div class="udetail${u.finished ? ' fin' : ''}" data-a="ud-${esc(u.id)}"><h3 class="sub">${unitDot(u)} ${unitLink(u.id, ctx)}${u.title ? ` ${esc(u.title)}` : ''}</h3>${parts}</div>` : '';
  };
  const html = v.units.map(one).join('');
  return html ? panel({ id: 'unit-details', title: 'Behaviours and evidence', count: v.units.reduce((n, u) => n + u.evidenceItems.length, 0), open: false, bodyHtml: html }) : '';
}

// ctx.readOnlyHint (plain text): where a read-only copy tells people to answer instead.
function needsPanel(v, form, ctx = {}) {
  const hint = form || !(v.needsYou.length + v.answered.length) ? ''
    : ctx.readOnlyHint ? `<p class="hint">${esc(ctx.readOnlyHint)}</p>`
      : `<p class="hint">This copy is read-only. Answer in the chat, or ask the lead for the answer page (<code>run.mjs serve ${esc(v.id)}</code>).</p>`;
  const open = v.needsYou.length ? `<ul class="qs">${v.needsYou.map((q) => questionItem(q, form, v.repo)).join('')}</ul>${hint}`
    : `<p class="empty">Nothing needs you.</p>${v.answered.length ? '' : hint}`;
  const answered = v.answered.length
    ? `<div class="answered-wait"><h3 class="sub">Answered, waiting for the lead</h3><p class="cause">Can be changed until the lead uses them.</p><ul class="qs">${v.answered.map((q) => questionItem(q, form, v.repo)).join('')}</ul>${v.needsYou.length ? '' : hint}</div>` : '';
  return panel({ id: 'needs', title: 'Needs you', count: v.needsYou.length, tone: v.needsYou.length ? 'ask' : '', bodyHtml: open + answered });
}

// Units the lead is handling (Retrying, Quiet), the next step, the time left and who leads.
function leadPanel(v, ctx) {
  const busy = v.units.filter((u) => ['retrying', 'stale'].includes(u.dot));
  const rows = busy.map((u) => `<div data-a="lead-${esc(u.id)}">${toneChip(u.badge?.label ?? u.dot, u.dot === 'stale' ? 'bad' : 'retry')}${unitLink(u.id, ctx)}<span>${esc(u.badge?.title ?? '')}</span></div>`).join('')
    + `<div data-a="lead-next"><span class="cause">Next step</span><span>${esc(v.next)}</span></div>`
    + `<div data-a="lead-left"><span class="cause">Time left</span><span>${esc(v.timeLeft)}</span></div>`
    + (v.lead ? `<div data-a="lead-who"><span class="cause">Lead</span><span>${esc(v.lead.tool)}, since ${esc(v.lead.since ?? '–')}, last active ${esc(v.lead.lastActive ?? 'at an unknown time')}${v.lead.goneText ? ` · ${esc(v.lead.goneText)}` : ''}</span></div>` : '');
  return panel({ id: 'lead', title: 'Lead', count: busy.length || null, bodyHtml: `<div class="rows">${rows}</div>` });
}

// The run's units as lanes over its time: one bar per try, from its start to its verdict (or now, for the
// try in progress), coloured and labelled by outcome, each linked to the unit's page.
export function lanes(v, nowMs, ctx) {
  const t0 = Date.parse(v.started); const t1 = v.closedAt ? Date.parse(v.closedAt) : nowMs;
  if (!(t1 > t0) || !v.units.length) return '<p class="empty">Nothing yet.</p>';
  const x = (t) => Math.min(100, Math.max(0, ((t - t0) / (t1 - t0)) * 100));
  const lane = (u) => {
    const segs = []; let from = null; let n = 0;
    for (const e of [...u.timeline].sort((a, b) => a.at.localeCompare(b.at))) {
      if (e.label === 'start') from ??= Date.parse(e.at);
      else if (/^verdict /.test(e.label)) { n++; const to = Date.parse(e.at); segs.push({ n, from: from ?? to, to, c: e.badge === 'pass' ? 'p' : 'f' }); from = null; }
    }
    if (from !== null && ['building', 'judging'].includes(u.status)) segs.push({ n: n + 1, from, to: t1, c: 'j' });
    const word = { p: 'passed', f: 'failed', j: 'in progress' };
    const bars = segs.map((s) => `<a class="seg ${s.c}" href="${esc(ctx.unitHref(u.id))}" style="left:${x(s.from).toFixed(2)}%;width:${Math.max(0.6, x(s.to) - x(s.from)).toFixed(2)}%" title="${esc(`${u.id} try ${s.n}: ${word[s.c]}`)}" aria-label="${esc(`${u.id} try ${s.n}: ${word[s.c]}`)}">T${s.n}</a>`).join('');
    return `<div class="lane${u.finished ? ' fin' : ''}" data-a="lane-${esc(u.id)}"><a class="mono" href="${esc(ctx.unitHref(u.id))}">${esc(u.id)}</a><div class="track">${bars}</div></div>`;
  };
  return `<div class="scroll"><div class="lanes"><div class="ends"><span>${stamp(v.started, 'abs')}</span><span>${v.closedAt ? stamp(v.closedAt, 'abs') : 'now'}</span></div>${v.units.map(lane).join('')}</div></div>`;
}

// The run's numbers: units done, tries used with the critics' verdicts, time, ETA and the goal's behaviours.
function runKpis(v) {
  const st = v.status;
  const used = v.units.reduce((n, u) => n + u.rounds, 0); const cap = v.units.reduce((n, u) => n + u.maxRounds, 0);
  const verdicts = v.units.reduce((n, u) => n + u.roundList.reduce((m, r) => m + 1 + Object.keys(r.specialists ?? {}).length, 0), 0);
  const time = v.budget.find((b) => b.name === 'time');
  const g = v.goalCheck; const passing = g.behaviours.filter((b) => b.status === 'pass').length;
  return kpis([
    // No unit done yet but work under way (#71): no empty 0% bar; the work is in words below.
    { k: 'Units', v: `${st.done} of ${st.total}`, ...(st.done || !st.work?.length ? { bar: st.pct } : {}), s: [st.stopped ? `${st.stopped} stopped` : '', st.work?.length ? `${st.work.length} in work` : ''].filter(Boolean).join(' · ') },
    { k: 'Tries', v: `${used} of ${cap}`, s: `${verdicts} ${verdicts === 1 ? 'verdict' : 'verdicts'}` },
    ...(time ? [{ k: 'Time', v: `${time.used} of ${time.max} min`, s: time.note ?? '' }] : []),
    { k: 'ETA', v: st.eta.short },
    { k: 'Goal', v: g.behaviours.length ? `${passing} of ${g.behaviours.length}` : g.met ? 'met' : 'not yet', s: g.behaviours.length ? 'behaviours passing' : '' },
  ]);
}

const STATUS_TONE = { running: 'ok', waiting: 'ask', paused: 'retry', finishing: 'done' };
const OUTCOME_TONE = { done: 'ok', partial: 'ask', stopped: 'bad' };
// The breadcrumb: This PC (when the page knows where it is), the project, the run, and below it a unit or one of
// the run's pages (Maps, Report, Retro, Project map).
export function runCrumbs(v, ctx, sub = null) {
  const project = v.project ?? ctx.project ?? null;
  return [...(ctx.pc ? [ctx.pc] : []), ...(project ? [{ label: project }] : []), sub ? { label: v.id, href: ctx.home } : { label: v.id }, ...(sub ? [{ label: sub }] : [])];
}
export const runFlag = (st) => (st ? toneChip(st.word, st.concluded ? OUTCOME_TONE[st.outcome] : STATUS_TONE[st.kind]) : '');

export function goalBlock(v, ctx) {
  const g = v.goalCheck;
  const passing = g.behaviours.filter((b) => b.status === 'pass').length;
  return `<section class="goal${g.met ? ' met' : ''}"><h3>Goal: ${chip(g.met ? 'met' : 'not yet', g.met ? 'met' : 'not-yet')}`
    + `${g.behaviours.length ? ` <span class="cause">${passing}/${g.behaviours.length} behaviours pass</span>` : ''}</h3><p>${linkify(v.goal, v.repo)}</p>`
    + (g.behaviours.length ? behaviourList(g.behaviours, v.repo, g.evidence, ctx, 'goal') : '')
    + evidenceList(g.evidence.filter((e) => !e.behaviour), v.repo, ctx, 'goal-ev') + '</section>';
}

function listBody(title, items, repo) {
  return items.length ? grows(`<ul>${keyed(items, (t) => `l-${title}-${hash(t)}`).map(([t, k]) => `<li data-a="${k}">${linkify(t, repo)}</li>`).join('')}</ul>`) : '<p class="empty">None.</p>';
}
const listPanel = (id, title, items, repo, open = false) => panel({ id, title, count: items.length, open, scroll: 360, bodyHtml: `<div data-a="list-${esc(title)}">${listBody(title, items, repo)}</div>` });

// Open questions only, counted; answered ones in a dimmed, collapsed group with the answer first.
function questionsPanel(v, repo) {
  const open = v.questions.length ? grows(`<ul>${keyed(v.questions, (q) => `l-Questions-${hash(`${q.label}|${q.text}`)}`).map(([q, k]) => `<li data-a="${k}">${qLabel(q)}${linkify(q.text, repo)}</li>`).join('')}</ul>`) : '<p class="empty">None open.</p>';
  const done = v.answeredQuestions.map((q) => `<li data-a="aq-${esc(q.id)}">${qLabel(q)}<b>${esc(q.id)}</b> ${esc(q.title)}`
    + `<p class="ans"><b>Answered:</b> ${linkify(q.answer, repo)} <span class="cause">— by ${q.by === 'person' ? 'you' : esc(q.by)}${q.at ? `, ${stamp(q.at)}` : ''}</span></p>`
    + `${q.decision ? `<p class="cause">Decision: ${linkify(q.decision, repo)}</p>` : ''}</li>`).join('');
  return panel({ id: 'questions', title: 'Questions', count: v.questions.length, open: v.questions.length > 0, scroll: 420,
    bodyHtml: `<div data-a="list-Questions">${open}${done ? toggle('answered-questions', `Answered · ${v.answeredQuestions.length}`, grows(`<ul class="answered">${done}</ul>`)) : ''}</div>` });
}

function budgetPanel(v) {
  const rows = v.budget.map((b) => `<div class="brow" data-a="budget-${esc(b.name)}" title="${esc(BUDGET_HELP[b.name] ?? '')}"><div class="row"><span>${esc(b.name)}</span><b class="mono">${b.used}/${b.max}${b.unit ? ` ${esc(b.unit)}` : ''}</b></div>${b.note ? `<p class="meta">${esc(b.note)}</p>` : ''}${bar(b.used, b.max, b.name !== 'units' && pct(b.used, b.max) >= 90 ? 'hot' : '', BUDGET_HELP[b.name])}</div>`).join('');
  return panel({ id: 'budget', title: 'Budget', open: false, bodyHtml: `<div class="budget-rows">${rows}${escapeCard(v.escapes)}${modelCard(v.models, v.modelsUnrecorded)}${costCard(v.cost)}</div>` });
}

// The timeline's list; its block is a .list-anchor container (issue #23).
export const timelineOl = (rows) => `<ol class="timeline" data-tl-list data-ev-list>${rows}</ol>`;
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
  const st = v.status;
  const g = v.goalCheck;
  const fin = new Set(v.units.filter((u) => u.finished).map((u) => u.id));
  const meta = `<p class="meta runmeta">${esc(v.tag)} · ${st ? `${esc(st.word)} · ` : ''}phase ${esc(v.phase)} · started ${stamp(v.started)} · updated ${stamp(new Date(nowMs).toISOString())}${ctx.mapHref ? ` · <a class="open" href="${esc(ctx.mapHref)}">Project map →</a>` : ''}</p>`;
  const main = [
    blk('needs', needsPanel(v, form, ctx)),
    blk('units', unitsPanel(v, ctx, r), 'div', ' id="unit-list"'),
    blk('unit-details', detailsPanel(v, ctx, form, r)),
    blk('lanes', panel({ id: 'lanes', title: 'Timeline', bodyHtml: lanes(v, nowMs, ctx) })),
    blk('activity', panel({ id: 'activity', title: 'Activity', count: Math.min(v.timeline.length, TIMELINE_MAX),
      bodyHtml: `${ctx.live ? timelineTools(v.units.map((u) => u.id)) : ''}<div class="list-anchor">${timelineOl(timelineList(v.timeline, r, fin, ctx))}</div>` }), 'div', ' id="timeline"'),
  ];
  const side = [
    blk('lead', leadPanel(v, ctx)),
    blk('goal', panel({ id: 'goal', title: 'Goal', count: g.behaviours.length ? `${g.behaviours.filter((b) => b.status === 'pass').length} / ${g.behaviours.length}` : null, scroll: 520, bodyHtml: goalBlock(v, ctx) })),
    blk('decisions', listPanel('decisions', 'Decisions', v.decisions, r)),
    blk('questions', questionsPanel(v, r)),
    blk('follow-ups', listPanel('follow-ups', 'Follow-ups', v.followUps, r)),
    blk('person-notes', listPanel('person-notes', 'Notes from you', v.personNotes.map((n) => `${n.unit ? `${n.unit}: ` : ''}${n.text}`), r)),
    blk('budget', budgetPanel(v)),
    v.integration.length ? blk('integration', panel({ id: 'integration', title: 'Integration', count: v.integration.length, bodyHtml: `<p>${v.integration.map((x) => chip(x, x)).join(' → ')}</p>` })) : '',
    blk('gbf', panel({ id: 'gbf', title: 'Goal, bar and fence', open: false, bodyHtml: `<dl class="kv"><dt>Goal</dt><dd>${linkify(v.goal, r)}</dd><dt>Bar</dt><dd>${linkify(v.bar, r)}</dd><dt>Fence</dt><dd>${linkify(v.fence, r)}</dd></dl>` })),
    form ? blk('note', panel({ id: 'note', title: 'Note to lead', open: false, bodyHtml: noteForm(form) })) : '',
  ];
  const body = [
    blk('head', heading(v.id, clip(v.goal, 140)) + meta),
    st ? blk('status', statusBlock(st, ctx)) : '',
    v.origin ? blk('origin', originLine(v.origin)) : '',
    blk('situation', `<div class="situation"><p>${linkify(v.situation.text, r)}</p><p class="meta">Situation · ${v.situation.computed ? 'counted from the state' : `the lead, ${stamp(v.situation.at)}`}</p></div>`),
    v.retroPending ? blk('retro-pending', pendingBanner(v, !v.open, ctx.project)) : '',
    st ? blk('kpis', runKpis(v)) : '',
    cols(main.join('\n'), side.join('\n')),
    blk('evv', viewer(viewerEntries(v), ctx, r)),
  ].join('\n');
  return page({ title: v.id, body, ctx, path: ctx.base || '/', closed: !v.open, crumbs: runCrumbs(v, ctx), flag: runFlag(st) });
}


// Builder models: rounds and pass rate each, so a cheaper builder that fails more shows up.
function modelCard(m, none = 0) {
  if (!m?.length && !none) return '';
  return `<div class="brow" data-a="budget-models" title="Rounds built on each model, and how many the critic passed"><div class="row" style="margin:0"><span>builder models</span><b>${esc(modelLine(m ?? [], none))}</b></div></div>`;
}

// Cost: tokens, minutes and money per run, unit and model, as the lead recorded them (lib/cost.mjs).
function costCard(c) {
  if (!c) return '';
  const items = [...c.byUnit.map((u) => `<li>${esc(u.id)}: ${esc(u.line)}</li>`), ...c.byModel.map((m) => `<li>model ${esc(m.model)}: ${esc(m.line)}</li>`)].join('');
  return `<div class="brow" data-a="budget-cost" title="Tokens, minutes and cost each launch reported, as the lead recorded them"><div class="row" style="margin:0"><span>cost</span><b>${esc(c.run)}</b></div>${items ? `<ul>${items}</ul>` : ''}</div>`;
}

// Escapes: defects found after a unit passed, from note --kind escape. Shown once there is a pass.
function escapeCard(e) {
  if (!e || (!e.passed && !e.escapes)) return '';
  const items = e.list.map((x) => `<li>${esc(x.unit)}${x.round ? ` (passed in try ${x.round})` : ''}: ${esc(clip(x.text, 160))}</li>`).join('');
  return `<div class="brow" data-a="budget-escapes" title="Defects found after a unit passed: in a later review, in verify, on test or by a person"><div class="row" style="margin:0"><span>escapes</span><b>${esc(escapeLine(e))}</b></div>${items ? `<ul>${items}</ul>` : ''}</div>`;
}
