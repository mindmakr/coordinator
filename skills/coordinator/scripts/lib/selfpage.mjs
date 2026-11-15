// The coordinator's own page (/coordinator when served, coordinator.html in the
// state folder on disk, /p/<key>/coordinator on the PC dashboard): a KPI row, then
// one panel per entry of SECTIONS in a main and a side column, each panel's body a
// keyed block the live page patches in place. To add a section, add an entry:
// { id, title, side?, open?, count?(model), render(model, ctx) }. Same shell, theme
// and escaping rules as the dashboard; the panels are lib/ui.mjs components.
import { anchor, linkify, webUrl } from './links.mjs';
import { count } from './self.mjs';
import { KIND_LABEL, gapHaystack } from './gaps.mjs';
import { clip } from './plain.mjs';
import { ageText } from './age.mjs';
import { badge, bar, blk, chip, cols, esc, hash, keyed, kpis, linkUnits, page, panel, rows, stamp, stateChip, table, toggle, unitDot } from './parts.mjs';
import { progressBar, statusChip } from './hud.mjs';
import { pcSection } from './dashboard.mjs';
import { clock } from './progress.mjs';

const LESSONS_SHOWN = 12;
const pct = (v) => (v === null || v === undefined ? '–' : `${v}%`);
const num = (v, unit = '') => (v === null || v === undefined ? '–' : `${v}${unit}`);
const sources = (list) => list.map(webUrl).filter(Boolean).map((u) => anchor(u, new URL(u).hostname)).join(', ');
// COORDINATOR.md is Markdown: `code` spans read as code (the text is already escaped).
const fact = (t) => linkify(t, null).replace(/`([^`<]+)`/g, '<code>$1</code>');
const empty = (t) => `<p class="empty">${esc(t)}</p>`;

// A run's dashboard: the served one is home, the others are read-only pages (or their hud.html on disk).
// A unit page of another run, from that run's link: <run>/units/<id>.html on disk, /run/<run>/unit/<id> (or /unit/<id>) when served.
const unitHrefIn = (ctx, run) => (id) => {
  const [p, q] = ctx.runHref(run).split('?'); const e = encodeURIComponent(id);
  const path = p.endsWith('hud.html') ? p.replace(/hud\.html$/, `units/${e}.html`) : `${p.replace(/\/$/, '')}/unit/${e}`;
  return q ? `${path}?${q}` : path;
};
const runLink = (id, ctx, m) => (m.runIds.includes(id) ? `<a href="${esc(ctx.runHref(id))}">${esc(id)}</a>` : esc(id));
const unitLink = (run, id, ctx, m) => (m.runIds.includes(run) ? `<a href="${esc(unitHrefIn(ctx, run)(id))}">${esc(id)}</a>` : esc(id));
// An open question of a run: its card on that run's dashboard (lib/hud.mjs questionItem, id = the question id).
const questionLink = (run, q, ctx, m) => (m.runIds.includes(run) ? `<a href="${esc(`${ctx.runHref(run)}#${encodeURIComponent(q.id)}`)}">${esc(q.id)}</a>` : esc(q.id));
const stat = (label, value, help = '') => `<div class="card stat"${help ? ` title="${esc(help)}"` : ''}><span>${esc(label)}</span><b>${value}</b></div>`;
const needsLine = (run, list, ctx, m) => (list.length ? `<p class="from"><b>Needs you:</b> ${list.map((q) => `${questionLink(run, q, ctx, m)} ${esc(q.text)}`).join(' · ')}</p>` : '');

// What a run is doing, with the units it names linked to their pages (only for a run whose page is linked).
const doingHtml = (st, ctx, m) => linkUnits(st.doing, st.current, (id) => (m.runIds.includes(st.run) ? unitHrefIn(ctx, st.run)(id) : null));

// Active runs: what is still running, how far along, and when the machine frees up (lib/progress.mjs).
function runRow(st, ctx, m) {
  const body = st.concluded
    ? `<p class="say">${linkify(st.reason, null)}.</p><p class="cause">Delivered: ${st.delivered.length ? st.delivered.map((d) => linkify(d, null)).join('; ') : 'nothing'} · ${st.followUps} ${st.followUps === 1 ? 'follow-up' : 'follow-ups'} in <a href="#self-gaps">Gaps</a> · closed ${stamp(st.closedAt)}</p>`
    : `<p class="say"><b>${esc(st.progress)}</b> · ${doingHtml(st, ctx, m)}</p>${progressBar(st, true)}<p class="cause">${esc(st.eta.text[0].toUpperCase() + st.eta.text.slice(1))}</p>${needsLine(st.run, st.needsYou, ctx, m)}`;
  return `<li class="card run-row${st.concluded ? ' fin' : ''}" data-a="run-${esc(st.run)}"><h3><span>${runLink(st.run, ctx, m)}${st.run === m.current ? ' <span class="cause">this dashboard</span>' : ''}</span>${statusChip(st)}</h3>${body}</li>`;
}
function activeRuns(m, ctx) {
  const a = m.active;
  if (!a) return '';
  const free = a.runs.length
    ? (a.free.at ? `free around <b>${esc(clock(Date.parse(a.free.at), Date.now()))}</b> local time${a.free.unknown ? ` (${a.free.unknown} with no estimate yet)` : ''}` : 'no estimate yet of when the machine is free')
    : 'the machine is free';
  const head = `<p class="meta"><b>${a.runs.length ? `${count(a.runs.length, 'run')} active` : 'No active run'}</b> · ${free}.</p>`;
  return head + (a.runs.length ? `<ul class="plain run-rows">${a.runs.map((st) => runRow(st, ctx, m)).join('')}</ul>` : '');
}
function concludedRuns(m, ctx) {
  const a = m.active;
  if (!a) return '';
  if (!a.concluded.length) return empty('No concluded run.');
  return `<ul class="plain run-rows">${a.concluded.map((st) => runRow(st, ctx, m)).join('')}</ul>${a.older ? `<p class="cause">${count(a.older, 'older concluded run')} in <a href="#self-history">History</a>.</p>` : ''}`;
}

function age(m, ctx) {
  const a = m.age;
  if (!a.runs) return empty('No run yet.');
  return `<div class="budget">${stat('Runs', `${a.runs}${a.open ? ` <span class="cause">${a.open} open</span>` : ''}`)}${stat('Units', a.units)}`
    + `${stat('Hours at work', a.hours, 'From each run’s start to its close or its last event.')}`
    + `${stat('First run', `${stamp(a.firstRun)} <span class="cause">${runLink(a.firstRunId, ctx, m)}</span>`)}</div>`;
}

function lessonItem(l, ctx, m, repo) {
  const from = l.from.length ? ` · from ${l.from.map((r) => runLink(r, ctx, m)).join(', ')}` : '';
  const src = sources(l.sources);
  return `<li data-a="lesson-${esc(l.id)}">${badge(l.tag === 'security' ? 'stop' : l.tag === 'design' ? 'behaviour' : 'info', l.tag)}${l.promote ? ` ${chip('promote', 'pass')}` : ''} ${linkify(l.text, repo)}`
    + `<div class="cause">${esc(l.id)} · seen ${l.seen} · used ${l.used} · ${esc(l.scope)}${from}${src ? ` · source ${src}` : ''}</div></li>`;
}

function learning(m, ctx) {
  const L = m.learning.lessons;
  if (!L.length) return empty('No lessons yet.');
  const head = `<p class="meta">${count(L.length, 'lesson')} · ${m.learning.promoted} ready to promote (seen 3 or more times) · tags: ${m.learning.tags.map((t) => esc(t)).join(', ')}</p>`;
  const list = (xs) => `<ul class="plain">${xs.map((l) => lessonItem(l, ctx, m, null)).join('')}</ul>`;
  return head + list(L.slice(0, LESSONS_SHOWN)) + (L.length > LESSONS_SHOWN ? toggle('self-more-lessons', `More lessons · ${L.length - LESSONS_SHOWN}`, list(L.slice(LESSONS_SHOWN))) : '');
}

// Project facts: the project's COORDINATOR.md, by its sections.
function memory(m) {
  const c = m.memory;
  if (!c.hasContext) return empty('No COORDINATOR.md in this project yet.');
  return c.context.map((s) => `<section data-a="mem-${esc(hash(s.title))}"><h3 class="sub">${esc(s.title)} <span class="count">${s.facts.length}</span></h3>`
    + `<ul class="rows">${keyed(s.facts, (f) => `f-${hash(f)}`).map(([f, k]) => `<li data-a="${k}">${fact(f)}</li>`).join('')}</ul></section>`).join('');
}

// Your decisions: the answers you gave in past runs, latest 30.
function decisions(m, ctx) {
  const ds = m.memory.decisions.slice(0, 30);
  if (!ds.length) return empty('No answers from you yet.');
  return `<ul class="rows">${ds.map((d) => `<li data-a="dec-${esc(d.run)}-${esc(d.id)}-${esc(hash(d.answer))}"><span class="grow"><b>${linkify(d.answer, null)}</b>${d.question ? ` <span class="muted">${esc(d.question)}</span>` : ''}</span>`
    + `<span class="muted">${runLink(d.run, ctx, m)} ${questionLink(d.run, d, ctx, m)} · ${stamp(d.at)}</span></li>`).join('')}</ul>`;
}

function stats(m) {
  const s = m.stats;
  if (!s.units) return empty('No finished unit yet.');
  const c = s.closed;
  const basis = `<p class="meta">Counted over ${count(s.units, 'finished unit')} in all runs, open included. `
    + (c.runs ? `Closed runs only, as <code>run.mjs stats</code> counts: pass rate ${pct(c.passRate)}, rounds to pass median ${num(c.medianRoundsToPass)} (p80 ${num(c.p80RoundsToPass)}), stopped ${pct(c.stoppedShare)}${c.unfinished ? `, unfinished ${c.unfinished} (left open when the run closed: neither passed nor stopped)` : ''} of ${count(c.units, 'unit')} in ${count(c.runs, 'closed run')}.</p>`
      : 'No closed run yet, so <code>run.mjs stats</code> has nothing to count.</p>');
  return basis + `<div class="budget">${stat('Pass rate', pct(s.passRate), 'Finished units that passed.')}`
    + stat('Rounds to pass', `${num(s.medianRoundsToPass)} <span class="cause">median · p80 ${num(s.p80RoundsToPass)}</span>`, 'Tries a passing unit needed.')
    + stat('Stopped', pct(s.stoppedShare), 'Finished units the rules stopped. Over 20% means the bars or splits need work.')
    + stat('Time per unit', num(s.minutesPerUnit, ' min'), 'Median, from a unit’s first build to its last verdict.')
    + `${s.suggestedMaxRounds ? stat('Suggested --max-rounds', s.suggestedMaxRounds, 'p80 rounds to pass, plus one, at most 8.') : ''}</div>`;
}

// Trend over runs: each run's finished units, pass rate, rounds and time.
function trend(m, ctx) {
  const t = m.stats.trend ?? [];
  return table({
    cols: [{ label: 'Run' }, { label: 'Passed', num: true }, { label: 'Pass rate' }, { label: 'Median rounds', num: true }, { label: 'Time per unit', num: true }],
    rows: t.map((r) => [{ html: runLink(r.run, ctx, m) }, `${r.passed}/${r.finished}`, { html: `${pct(r.passRate)}${r.passRate === null ? '' : bar(r.passRate)}` }, num(r.medianRounds), num(r.minutesPerUnit, ' min')]),
    min: 560, max: 360, empty: 'No finished unit yet.',
  });
}

// Work across runs (#36): a unit stopped in one run and finished in a follow-on run, counted once in the stats.
function chains(m, ctx) {
  if (!m.chains?.length) return empty('No unit worked across runs.');
  return `<p class="meta">A unit stopped in one run and finished in another counts once.</p><ul class="rows">${m.chains.map((c) => `<li data-a="chain-${esc(c.links[0].run)}-${esc(c.unit)}"><b class="mono">${unitLink(c.links.at(-1).run, c.links.at(-1).unit, ctx, m)}</b>`
    + `<span class="grow">${c.links.map((l) => `${runLink(l.run, ctx, m)}${l.unit !== c.unit ? `<span class="cause">:${unitLink(l.run, l.unit, ctx, m)}</span>` : ''} <span class="cause">(${l.rounds} ${l.rounds === 1 ? 'try' : 'tries'}, ${esc(l.status)})</span>`).join(' → ')}</span>`
    + `<span class="muted">${c.rounds} ${c.rounds === 1 ? 'round' : 'rounds'}</span>${chip(c.status, c.status)}</li>`).join('')}</ul>`;
}

function history(m, ctx) {
  return table({
    cols: [{ label: 'Run' }, { label: 'Outcome' }, { label: 'Units passed' }, { label: 'Started' }, { label: 'Closed' }],
    rows: m.history.map((h) => [{ html: `${runLink(h.run, ctx, m)}<div class="muted">${linkify(h.goal, null)}</div>` }, { html: h.status ? statusChip(h.status) : chip(h.outcome, h.outcome) },
      { html: `${h.passed}/${h.units}${h.stopped ? ` <span class="cause">${h.stopped} stopped</span>` : ''}` }, { html: stamp(h.started) }, { html: stamp(h.closed) }]),
    min: 640, max: 420, empty: 'No closed run yet.',
  });
}

function plans(m, ctx) {
  if (!m.plans.length) return empty('No open run.');
  return `<div class="grid">${m.plans.map((p) => {
    const linked = m.runIds.includes(p.run);
    const left = p.left.length ? `<ul>${p.left.map((u) => `<li data-a="left-${esc(p.run)}-${esc(u.id)}">${u.dot ? `${unitDot(u)} ` : ''}<b>${unitLink(p.run, u.id, ctx, m)}</b>${u.title ? ` ${esc(u.title)}` : ''} ${stateChip(u, linked ? { unitHref: unitHrefIn(ctx, p.run) } : null)} <span class="cause">waits on ${esc(u.waitsOn)}</span></li>`).join('')}</ul>` : empty('Nothing left: integration and the retro.');
    return `<section class="card" data-a="plan-${esc(p.run)}"><h3><span>${runLink(p.run, ctx, m)}${p.run === m.current ? ' <span class="cause">this dashboard</span>' : ''}</span>${p.status ? statusChip(p.status) : chip(p.decision, p.decision)}</h3>`
      + `<p class="say">${linkify(p.goal, null)}</p><div class="row"><span>${p.status ? esc(p.status.progress) : `${p.done} of ${count(p.total, 'unit')} finished`}</span><span>phase ${esc(p.decision)}</span></div>${p.status ? progressBar(p.status, true) : bar(p.total ? Math.round((p.done / p.total) * 100) : 0)}`
      + `<div class="unit-next"><b>Next:</b> ${p.next.length ? esc(p.next.join(' · ')) : 'wait for the running agents'}</div>${needsLine(p.run, p.needsYou, ctx, m)}${left}</section>`;
  }).join('')}</div>`;
}

// Gaps: everything left undone across runs, grouped by run. The filter and search need the live
// page's script, so the snapshot has neither and lists them all. Resolved gaps stay listed, folded.
const GAP_BADGE = { stopped: 'stop', unfinished: 'fail', run: 'stop', 'follow-up': 'link', 'out-of-fence': 'strategy', deferred: 'note', upstream: 'merge', question: 'question', escape: 'fail' };
const GAP_CLIP = 220;
const REASON_CLIP = 160;
const gapsLine = (g) => `${count(g.openCount, 'open gap')} across ${count(g.openRuns, 'run')}`;
function gapItem(g, ctx, m) {
  const unit = g.unit ? (m.runIds.includes(g.run) ? ` · unit <a href="${esc(unitHrefIn(ctx, g.run)(g.unit))}">${esc(g.unit)}</a>` : ` · unit ${esc(g.unit)}`) : '';
  const long = g.text.length > GAP_CLIP;
  const text = long ? `${esc(clip(g.text, GAP_CLIP))}${toggle(`gap-${g.id}`, 'Full text', `<p class="say">${linkify(g.text, null)}</p>`)}` : linkify(g.text, null);
  const r = g.resolution;
  const why = r ? (r.reason.length > REASON_CLIP ? `<span title="${esc(r.reason)}">${esc(clip(r.reason, REASON_CLIP))}</span>` : linkify(r.reason, null)) : '';
  const res = r ? `<div class="cause"><b>Resolved</b> ${r.derived ? '(from the state)' : r.checked ? `by ${esc(r.by)}, checked with gh` : `by ${esc(r.by)}${r.confirm ? `, their words: “${esc(clip(r.confirm, 120))}”` : ''}`}: ${why}${r.at ? ` · ${stamp(r.at)}` : ''}</div>` : '';
  const unverified = g.unverified ? `<div class="cause"><b>tracked (unverified)</b>: ${g.unverified.map((u) => linkify(u, null)).join(', ')}, a repo the runs do not link; <code>run.mjs gaps --check</code> confirms it exists</div>` : '';
  const carried = g.carried ? `<div class="cause"><b>carried → ${esc(g.carried)}</b>: open until that unit passes or its gap is resolved</div>` : '';
  return `<li data-a="gap-${esc(g.id)}" data-gap data-run="${esc(g.run)}" data-kind="${esc(g.kind)}"${ctx.live ? ` data-q="${esc(gapHaystack(g))}"` : ''}>${badge(GAP_BADGE[g.kind] ?? 'info', KIND_LABEL[g.kind] ?? g.kind)} ${text}`
    + `${g.cause ? `<div class="cause">cause: ${esc(g.cause)}</div>` : ''}`
    + `<div class="cause">${runLink(g.run, ctx, m)}${unit}${g.at ? ` · ${stamp(g.at)}` : ''} · from ${esc(g.from)} · <code>${esc(g.id)}</code></div>${carried}${unverified}${res}</li>`;
}
const gapGroups = (groups, ctx, m, status) => groups.map((grp) => `<section class="card gap-run" data-gap-group data-run="${esc(grp.run)}" data-status="${status}" data-a="gaps-${status}-${esc(grp.run)}"><h3><span>${runLink(grp.run, ctx, m)}</span><span class="chip" data-gap-n>${grp.items.length}</span></h3>`
  + `<ul class="plain">${grp.items.map((g) => gapItem(g, ctx, m)).join('')}</ul></section>`).join('');
function gapTools(g) {
  const opts = (vals, label) => vals.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
  return '<form class="tl-tools gap-tools" data-gaps role="search">'
    + '<label class="grow">Search gaps<input type="search" name="q" placeholder="text, run, unit, #123, PR…" autocomplete="off" spellcheck="false"></label>'
    + `<label>Run<select name="run"><option value="">All runs</option>${opts(g.runs, (v) => v)}</select></label>`
    + `<label>Kind<select name="kind"><option value="">All kinds</option>${opts(g.kinds, (v) => KIND_LABEL[v] ?? v)}</select></label>`
    + '<label>Status<select name="status"><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select></label>'
    + '<p class="cause gap-count" data-gaps-count aria-live="polite"></p></form>';
}
function gapsSection(m, ctx) {
  const g = m.gaps;
  if (!g.openCount && !g.resolvedCount) return empty('No gaps: none open or resolved in any run.');
  const head = `<p class="meta"><b>${gapsLine(g)}</b> · ${g.resolvedCount} resolved · close one with <code>run.mjs gap close &lt;run&gt; &lt;id&gt; --reason R</code> · `
    + (g.lastCheck ? `Last checked against GitHub ${stamp(g.lastCheck.at)}: ${count(g.lastCheck.asked, 'reference')} asked, ${g.lastCheck.closed} closed.</p>` : 'Not checked against GitHub yet: <code>run.mjs gaps --check --dry-run</code>.</p>');
  const open = g.openCount ? `<div class="lists gaps" data-gaps-open>${gapGroups(g.open, ctx, m, 'open')}</div>` : `<div data-gaps-open>${empty('No open gap.')}</div>`;
  const resolved = g.resolvedCount ? `<div data-gaps-resolved>${toggle('self-gaps-resolved', `Resolved · ${g.resolvedCount}`, `<div class="lists gaps">${gapGroups(g.resolved, ctx, m, 'resolved')}</div>`)}</div>` : '';
  return head + (ctx.live ? gapTools(g) : '') + open + resolved;
}

const PROPOSAL_BADGE = { upstream: 'merge', 'follow-up': 'link', retro: 'note', promote: 'pass' };
function proposals(m, ctx) {
  if (!m.proposals.length) return empty('No proposals yet.');
  return `<ul class="rows">${keyed(m.proposals, (p) => `p-${p.kind}-${p.run}-${hash(p.text)}`).map(([p, k]) => `<li data-a="${esc(k)}">${badge(PROPOSAL_BADGE[p.kind] ?? 'info', p.kind)}<span class="grow">${linkify(p.text, null)}</span>`
    + `<span class="muted">${p.run ? runLink(p.run, ctx, m) : ''}${p.at ? ` ${stamp(p.at)}` : ''}</span></li>`).join('')}</ul>`;
}

function study(m, ctx) {
  const s = m.study;
  const caps = s.runs.filter((r) => r.open || r.used).map((r) => `<li data-a="cap-${esc(r.run)}"><span class="grow">${runLink(r.run, ctx, m)}</span><b>${r.used}/${r.cap}</b>${bar(r.cap ? Math.round((r.used / r.cap) * 100) : 100, { label: `${r.used} of ${r.cap} studies used` })}</li>`).join('');
  const log = s.log.length ? `<ul class="plain">${s.log.map((x) => `<li data-a="study-${esc(x.run)}-${esc(x.id)}">${badge(x.area === 'security' ? 'stop' : x.area === 'design' ? 'behaviour' : 'evidence', x.area)} <b>${esc(x.topic)}</b> ${linkify(x.text, null)}`
    + `<div class="cause">${runLink(x.run, ctx, m)} ${esc(x.id)} · ${stamp(x.at)} · sources ${sources(x.sources ?? []) || 'none'}${x.lessons?.length ? ` · lessons ${x.lessons.map(esc).join(', ')}` : ''}</div></li>`).join('')}</ul>`
    : empty('No study yet.');
  return (caps ? `<h3 class="sub">Studies used per run</h3><ul class="rows caps">${caps}</ul>` : '') + log;
}

// The panels: main column first, then the side; open as the approved canvas has them.
export const SECTIONS = [
  { id: 'trend', title: 'Trend over runs', open: true, count: (m) => m.stats.trend?.length, render: trend, flush: true },
  { id: 'learning', title: 'Learning', open: true, count: (m) => m.learning.lessons.length, render: learning },
  { id: 'proposals', title: 'Proposals', open: true, count: (m) => m.proposals.length, render: proposals },
  { id: 'chains', title: 'Work across runs', count: (m) => m.chains?.length ?? 0, render: chains },
  { id: 'gaps', title: 'Gaps', count: (m) => m.gaps.openCount, render: gapsSection },
  { id: 'plans', title: 'Plans', count: (m) => m.plans.length, render: plans },
  { id: 'history', title: 'History', count: (m) => m.history.length, render: history, flush: true },
  { id: 'active', title: 'Active runs', side: true, open: true, count: (m) => m.active?.runs.length, render: activeRuns },
  { id: 'concluded', title: 'Recently concluded', side: true, open: true, count: (m) => m.active?.concluded.length, render: concludedRuns },
  { id: 'decisions', title: 'Your decisions', side: true, open: true, count: (m) => m.memory.decisions.length, render: decisions },
  { id: 'stats', title: 'Working stats', side: true, render: stats },
  { id: 'age', title: 'Age', side: true, render: age },
  { id: 'memory', title: 'Project facts', side: true, count: (m) => m.memory.context.length, render: memory },
  { id: 'study', title: 'Side study', side: true, count: (m) => m.study.log.length, render: study },
  // Every run on this PC, across projects and tools (lib/registry.mjs, lib/dashboard.mjs).
  { id: 'pc', title: 'This PC', side: true, count: (m) => m.pc?.runs, render: pcSection, flush: false },
];

// The KPI row: age, pass rate, rounds to pass, lessons and open gaps.
function figures(m, nowMs) {
  const a = m.age; const s = m.stats; const g = m.gaps;
  return kpis([
    { k: 'Age', v: a.firstRun ? ageText(nowMs - Date.parse(a.firstRun)) : '–', s: count(a.runs, 'run') },
    { k: 'Pass rate', v: pct(s.passRate), s: count(s.units, 'finished unit') },
    { k: 'Rounds to pass', v: num(s.medianRoundsToPass), s: `median · p80 ${num(s.p80RoundsToPass)}` },
    { k: 'Lessons', v: m.learning.lessons.length, s: `${m.learning.promoted} ready to promote` },
    { k: 'Open gaps', v: g?.openCount ?? 0, s: g ? `${count(g.openRuns, 'run')} · ${g.resolvedCount} resolved` : '' },
  ]);
}

export function selfPage(m, nowMs = Date.now(), ctx) {
  const box = (s) => { const n = s.count ? s.count(m) : undefined; return panel({
    id: `self-${s.id}`, title: s.title, count: n, open: !!s.open, flush: !!s.flush && n > 0, // a table runs edge to edge; its empty line keeps the padding
    bodyHtml: blk(`self-${s.id}`, s.render(m, ctx), 'section', ` id="self-${s.id}" class="self"`),
  }); };
  const gapsLink = m.gaps?.openCount ? ` · <a href="#self-gaps">${gapsLine(m.gaps)}</a>` : '';
  const body = [
    blk('head', `<div class="head"><h1>Coordinator</h1><span class="muted">${ctx.project ? `${esc(ctx.project)} · ` : ''}across ${count(m.age.runs, 'run')} in this project${gapsLink}</span></div>`),
    ctx.live ? '' : blk('snapshot', `<p class="hint" role="note"><b>Snapshot written ${stamp(new Date(nowMs).toISOString())}.</b> The live page, with every run on this PC: <code>/coordinator:dashboard</code> (<code>run.mjs dashboard</code>).</p>`),
    blk('kpis', figures(m, nowMs)),
    cols(SECTIONS.filter((s) => !s.side).map(box).join(''), SECTIONS.filter((s) => s.side).map(box).join('')),
  ].join('\n');
  return page({ title: 'Coordinator', body, ctx, path: ctx.path ?? '/coordinator' });
}
