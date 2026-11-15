// One unit's page (/unit/<id> when served, units/<id>.html on disk), in the run's shell with a unit
// switcher: its numbers, summary, last gap, every round, evidence and artifacts, the functions its diff
// touched (when computed), its own timeline, its bar and behaviours, Depends on / Blocks, notes and
// questions, early reviews and its rounds in earlier runs. Same rules as the dashboard.
import { viewer, viewerEntries } from './evview.mjs';
import { linkify } from './links.mjs';
import { unitCalls } from './map/callsview.mjs';
import { clip, duration } from './plain.mjs';
import { whoRound } from './models.mjs';
import { gapEvidence } from './view.mjs';
import { activityBox, chainRow, lastGapHtml, liveCtx, noteForm, questionItem, runCrumbs, runFlag, scoreChart, scoreTrend, staticCtx, timelineList, timelineOl, tryStates, tryText, unitLinks } from './hud.mjs';
import { behaviourList, blk, blocksLine, chip, cols, esc, evidenceList, grows, hash, keyed, kpis, linkWaits, page, panel, stamp, stateChip, table, timelineTools, toneChip, tries, unitDot, unitLink } from './parts.mjs';

// Depends on / Blocks: each linked unit with its state dot and badge, linked to its page.
function links(u, ctx) {
  const row = (x) => `<li data-a="dep-${esc(x.id)}">${x.dot ? `${unitDot(x)} ${unitLink(x.id, ctx)}${x.title ? ` ${esc(x.title)}` : ''} ${stateChip(x, ctx)}` : `${esc(x.id)} <span class="cause">not in this run</span>`}</li>`;
  const part = (h, list, none) => `<h3 class="sub">${h}</h3>${list.length ? `<ul class="deps">${list.map(row).join('')}</ul>` : `<p class="empty">${none}</p>`}`;
  // Other units that change the same files (planned, or in their last checked diff).
  const shared = (u.overlaps ?? []).map((x) => `<li data-a="ov-${esc(x.id)}">${unitLink(x.id, ctx)} <span class="mono cause">${esc(x.paths.slice(0, 4).join(', '))}${x.paths.length > 4 ? ` and ${x.paths.length - 4} more` : ''}</span></li>`).join('');
  return `${part('Depends on', u.dependsOn, 'Nothing: it can start on its own.')}${part('Blocks', u.dependents, 'No unit waits on it.')}`
    + `<h3 class="sub">Overlaps</h3>${shared ? `<ul class="deps">${shared}</ul>` : '<p class="empty">No other unit changes its files.</p>'}`;
}

// Minutes as words, or a dash when not stamped.
const mins = (m) => (m === null || m === undefined ? '–' : duration(m));

// The Time KPI: working time over the tries' start and end stamps (lib/timeline.mjs tryTimes), build and review.
function timeKpi(u) {
  const t = u.time;
  if (!t || t.minutes === null) return { k: 'Time', v: '–', s: u.tries?.length ? 'no start recorded' : 'not started' };
  const s = [`build ${mins(t.build)}`, `review ${mins(t.review)}`, t.open ? 'try running' : '', t.unstamped ? `${t.unstamped} not stamped` : ''].filter(Boolean).join(' · ');
  return { k: 'Time', v: duration(t.minutes), s };
}

// The verdict a critic gave, as a chip; none given is a dash.
const verdictChip = (w) => (w ? toneChip(w, w === 'pass' ? 'ok' : w === 'fail' ? 'bad' : '') : '<span class="cause">–</span>');

// One round in full: who failed it, the builder's report, the gap with the evidence that goes with it
// (a specialist's own when it failed the round, #147), the general critic's evidence, and each behaviour mark.
function round(r, repo) {
  const marks = (r.behaviours ?? []).map((m) => `<li data-a="r${r.n}-${esc(m.id)}">${chip(m.status, m.status)} <b>${esc(m.id)}</b>${m.evidence ? ` ${linkify(m.evidence, repo)}` : ''}</li>`).join('');
  const score = r.score !== null && r.score !== undefined ? `score ${esc(r.score)}` : null;
  // A round the general critic passed and a specialist failed (#126): say who failed it, and the general verdict and score.
  const head = r.failedBy ? ` <span class="cause">failed by specialist ${esc(r.failedBy.join(', '))}</span> <span class="cause">general critic: ${esc(r.general ?? 'pass')}${score ? `, ${score}` : ''}</span>`
    : score ? ` <span class="cause">${score}</span>` : '';
  const ev = gapEvidence(r);
  const evidence = r.failedBy
    ? `${ev ? `<dt>Evidence (specialist ${esc(r.failedBy.join(', '))})</dt><dd>${linkify(ev, repo)}</dd>` : ''}${r.evidence ? `<dt>General critic's evidence</dt><dd>${linkify(r.evidence, repo)}</dd>` : ''}`
    : r.evidence ? `<dt>Critic's evidence</dt><dd>${linkify(r.evidence, repo)}</dd>` : '';
  return `<div class="round" data-a="round-${r.n}"><h4>Round ${r.n} ${chip(r.verdict, r.verdict)}${head}`
    + `${r.cause ? ` <span class="cause">cause: ${esc(r.cause)}</span>` : ''} ${stamp(r.at, 'cause')}</h4>`
    + (whoRound(r) ? `<p class="cause" data-a="r${r.n}-who">${esc(whoRound(r))}</p>` : '')
    + `<dl>${r.report ? `<dt>Builder's report</dt><dd>${linkify(r.report, repo)}</dd>` : ''}`
    + `${r.gap ? `<dt>Gap</dt><dd>${linkify(r.gap, repo)}</dd>` : ''}${evidence}</dl>`
    + (marks ? `<ul class="behaviours">${marks}</ul>` : '') + '</div>';
}

// Every round: the score per try, a table (try, time, verdict, the general critic, each specialist, score,
// gap), then each round in full.
function rounds(u, repo) {
  if (!u.roundList.length) return '<p class="empty">No round yet.</p>';
  const names = [...new Set(u.roundList.flatMap((r) => Object.keys(r.specialists ?? {})))];
  const cols = [{ label: 'Try' }, { label: 'Started' }, { label: 'Build', num: true }, { label: 'Review', num: true }, { label: 'Judged' }, { label: 'Verdict' }, { label: 'General' }, ...names.map((n) => ({ label: n })), { label: 'Score', num: true }, { label: 'Gap' }];
  const times = new Map((u.tries ?? []).map((t) => [t.n, t]));
  const rows = u.roundList.map((r) => ({ key: `rrow-${r.n}`, cells: [`T${r.n}`, { html: times.get(r.n)?.start ? stamp(times.get(r.n).start, 'abs') : '<span class="cause">–</span>' }, mins(times.get(r.n)?.build), mins(times.get(r.n)?.review), { html: stamp(r.at, 'abs') }, { html: verdictChip(r.verdict) },
    { html: verdictChip(r.failedBy ? (r.general ?? 'pass') : r.verdict) }, ...names.map((n) => ({ html: verdictChip(r.specialists?.[n]?.verdict) })),
    typeof r.score === 'number' ? r.score : '–', { html: r.gap ? linkify(clip(r.gap, 160), repo) : '<span class="cause">–</span>' }] }));
  return scoreChart(u.roundList) + table({ cols, rows, min: 760 + names.length * 80, max: 320 })
    + `<div class="round-list">${[...u.roundList].reverse().map((x) => round(x, repo)).join('')}</div>`;
}

// Early reviews (verdict --early, #66): a critic's look at work begun before the unit's try. Listed apart,
// never as a round; "before round N" is the round they came ahead of.
function earlyReviews(list, repo) {
  const line = (e) => `<li data-a="early-${esc(e.n)}">${chip(e.verdict, e.verdict)} <b>${esc(e.by)}</b> before round ${esc(e.before)}${typeof e.score === 'number' ? ` · score ${esc(e.score)}` : ''}${e.head ? ` · ${esc(String(e.head).slice(0, 12))}` : ''}`
    + `${e.gap ? ` · ${linkify(clip(e.gap, 200), repo)}` : ''}${e.evidence ? ` <span class="cause">${linkify(clip(e.evidence, 200), repo)}</span>` : ''} ${stamp(e.at, 'cause')}</li>`;
  return `<ol class="earlier">${list.map(line).join('')}</ol>`;
}

// The rounds this unit had in the runs it continues (#36), oldest first, one line each.
function earlier(runs, repo, id) {
  const line = (l, r) => `<li>${chip(r.verdict, r.verdict)} <b>${esc(l.run)}${l.unit !== id ? `:${esc(l.unit)}` : ''}</b> round ${esc(r.n)}${typeof r.score === 'number' ? ` · score ${esc(r.score)}` : ''}${r.gap ? ` · ${linkify(clip(r.gap, 200), repo)}` : ''}${r.cause ? ` <span class="cause">cause: ${esc(r.cause)}</span>` : ''}</li>`;
  const stops = runs.filter((l) => l.stopReason).map((l) => `<p><b>Stopped in ${esc(l.run)}${l.unit !== id ? `:${esc(l.unit)}` : ''}:</b> ${esc(l.stopReason)}</p>`).join('');
  return `<ol class="earlier">${runs.flatMap((l) => l.rounds.map((r) => line(l, r))).join('') || '<li class="empty">No round there.</li>'}</ol>${stops}`;
}

// Every unit of the run, the current one marked: its dot, id and state in words.
const unitBar = (v, u, ctx) => `<nav class="unitbar" aria-label="Units">${v.units.map((x) => `<a href="${esc(ctx.unitHref(x.id))}"${x.id === u.id ? ' aria-current="page"' : ''} data-a="ub-${esc(x.id)}">${unitDot(x)}<span class="mono">${esc(x.id)}</span><span class="muted">${esc(x.badge?.label ?? x.status)}</span></a>`).join('')}</nav>`;

export function unitPage(v, id, nowMs = Date.now(), ctx = null) {
  const u = v.units.find((x) => x.id === id);
  if (!u) return null;
  ctx ??= staticCtx('', 1);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const live = ctx.form ?? ctx.live;
  const form = live && v.open && !ctx.readOnly ? { ...live, back: `/unit/${u.id}` } : null; // forms come back here
  const r = v.repo;
  const waits = u.dependsOn.map((x) => x.id);
  const loose = u.evidenceItems.filter((e) => !e.behaviour);
  const calls = ctx.calls?.get(u.id) ?? null; // lib/map/calls.mjs, map/calls/<unit>.json
  const passing = u.behaviours.filter((b) => b.status === 'pass').length;
  const failing = u.behaviours.filter((b) => b.status === 'fail').length;
  const notes = keyed(u.personNotes, (n) => `n-${n.at}-${hash(n.text)}`).map(([n, k]) => `<li data-a="${esc(k)}">${linkify(n.text, r)} <span class="cause">${stamp(n.at)}</span></li>`).join('')
    + keyed(u.unitNotes ?? [], (n) => `ln-${n.at}-${hash(n.text)}`).map(([n, k]) => `<li data-a="${esc(k)}"><b>${esc(n.kind)}:</b> ${linkify(n.text, r)} <span class="cause">${stamp(n.at)}</span></li>`).join('');
  const earlierRuns = (u.chain?.before ?? []).filter((l) => l.known);
  const last = u.roundList.at(-1);
  const summary = `<dl class="kv"><dt>Bar</dt><dd>${linkify(u.bar, r)}</dd><dt>State</dt><dd data-a="say">${linkWaits(u.sentence, waits, ctx)}</dd>`
    + `<dt>Next</dt><dd class="next-step" data-a="next">${linkWaits(u.next, waits, ctx)}</dd>${u.who ? `<dt>Who</dt><dd>${esc(u.who)}</dd>` : ''}`
    + `${u.stopReason ? `<dt>Stopped</dt><dd>${esc(u.stopReason)}</dd>` : ''}</dl>${blocksLine(u, ctx)}${chainRow(u, ctx)}`;
  const main = [
    blk('summary', panel({ id: 'summary', title: 'Summary', bodyHtml: summary })),
    u.gap ? blk('last-gap', panel({ id: 'last-gap', title: 'Last gap', tone: 'bad', metaHtml: last ? `try ${esc(last.n)} · ${stamp(last.at)}` : '', bodyHtml: `<div class="lastgap">${lastGapHtml(u, r, false)}</div>` })) : '',
    blk('rounds', panel({ id: 'rounds', title: 'Rounds', count: u.roundList.length, bodyHtml: rounds(u, r) })),
    blk('evidence', panel({ id: 'evidence', title: 'Evidence and artifacts', count: loose.length, scroll: 480, bodyHtml: loose.length ? evidenceList(loose, r, ctx, `p-${u.id}-ev`) : '<p class="empty">No evidence outside the behaviours.</p>' })),
    // Shown wherever the pages read call data (map/calls/); before `run.mjs calls` it says how to compute it.
    ctx.calls ? blk('calls', panel({ id: 'calls', title: 'Function calls', count: calls ? calls.touchedTotal : null, open: false, bodyHtml: unitCalls(calls, r, v.id, u.id) })) : '',
    blk('timeline', panel({ id: 'unit-timeline', title: 'Unit timeline', count: u.timeline.length, open: false,
      bodyHtml: `${ctx.live ? timelineTools() : ''}${activityBox(timelineOl(timelineList([...u.timeline].reverse(), r, undefined, ctx)))}` }), 'div', ' id="timeline"'),
  ];
  const side = [
    blk('behaviours', panel({ id: 'behaviours', title: 'Bar and behaviours', count: u.behaviours.length ? `${passing} / ${u.behaviours.length}` : null, scroll: 520,
      bodyHtml: `<p class="cause">Bar: ${linkify(u.bar, r)}</p>${behaviourList(u.behaviours, r, u.evidenceItems, ctx, `p-${u.id}`)}` })),
    blk('deps', panel({ id: 'deps', title: 'Depends on / Blocks', bodyHtml: links(u, ctx) })),
    blk('notes', panel({ id: 'notes', title: 'Notes and questions', count: u.asks.length + u.personNotes.length + (u.unitNotes ?? []).length,
      bodyHtml: `${u.asks.length ? `<ul class="qs">${u.asks.map((q) => questionItem(q, form, r)).join('')}</ul>` : ''}`
        + (notes ? grows(`<ul>${notes}</ul>`) : (u.asks.length ? '' : '<p class="empty">None.</p>')) + (form ? noteForm(form, u.id) : '') })),
    u.earlyList?.length ? blk('early', panel({ id: 'early', title: 'Early reviews', count: u.earlyList.length, metaHtml: 'not rounds', open: false, bodyHtml: earlyReviews(u.earlyList, r) })) : '',
    earlierRuns.length ? blk('earlier', panel({ id: 'earlier', title: 'Earlier runs', count: earlierRuns.length, open: false, bodyHtml: earlier(earlierRuns, r, u.id) })) : '',
  ];
  const head = `<div class="head"><span class="mono muted">${esc(u.id)}</span><h1>${unitDot(u)} ${esc(u.title ?? u.id)}</h1>${stateChip(u, ctx)}<span class="meta">updated ${stamp(new Date(nowMs).toISOString())}</span></div>${unitLinks(u, r)}`;
  const body = [
    blk('unitbar', unitBar(v, u, ctx)),
    blk('head', head),
    blk('kpis', kpis([
      { k: 'Tries', vHtml: tries(tryStates(u)), s: tryText(u) },
      { k: 'Scores', v: scoreTrend(u) || '–', s: u.early ? u.early.text : '' },
      { k: 'Behaviours', v: u.behaviours.length ? `${passing} of ${u.behaviours.length}` : 'none', s: failing ? `${failing} failing` : '' },
      timeKpi(u),
    ])),
    cols(main.join('\n'), side.join('\n')),
    blk('evv', viewer(viewerEntries(v, u.id), ctx, r)),
  ].join('\n');
  return page({ title: `${u.id} · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/unit/${u.id}`, closed: !v.open, crumbs: runCrumbs(v, ctx, u.id), flag: runFlag(v.status) });
}
