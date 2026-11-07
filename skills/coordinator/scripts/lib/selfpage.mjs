// The coordinator's own page (/coordinator when served, coordinator.html in the
// state folder on disk): one section per entry of SECTIONS, each a keyed block
// the live page patches in place. To add a section, add an entry: { id, title,
// render(model, ctx) }. Same shell, theme and escaping rules as the dashboard.
import { anchor, linkify, webUrl } from './links.mjs';
import { count } from './self.mjs';
import { KIND_LABEL } from './gaps.mjs';
import { clip } from './plain.mjs';
import { badge, blk, chip, esc, hash, keyed, page, stamp, stateChip, toggle, unitDot } from './parts.mjs';

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
const stat = (label, value, help = '') => `<div class="card stat"${help ? ` title="${esc(help)}"` : ''}><span>${esc(label)}</span><b>${value}</b></div>`;
const meter = (p) => `<div class="bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, p ?? 0))}%"></i></div>`;

function age(m, ctx) {
  const a = m.age;
  if (!a.runs) return empty('No run yet. The first run starts the count.');
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
  if (!L.length) return empty('No lessons yet. The retro at the end of each run adds them (lessons.mjs add).');
  const head = `<p class="meta">${count(L.length, 'lesson')} · ${m.learning.promoted} seen 3 or more times and ready to promote into the references · tags: ${m.learning.tags.map((t) => esc(t)).join(', ')}</p>`;
  const list = (xs) => `<ul class="plain">${xs.map((l) => lessonItem(l, ctx, m, null)).join('')}</ul>`;
  return head + list(L.slice(0, LESSONS_SHOWN)) + (L.length > LESSONS_SHOWN ? toggle('self-more-lessons', `More lessons · ${L.length - LESSONS_SHOWN}`, list(L.slice(LESSONS_SHOWN))) : '');
}

function memory(m, ctx) {
  const c = m.memory;
  const facts = c.hasContext
    ? c.context.map((s) => `<section class="card" data-a="mem-${esc(hash(s.title))}"><h3>${esc(s.title)} <span class="chip">${s.facts.length}</span></h3><ul>${keyed(s.facts, (f) => `f-${hash(f)}`).map(([f, k]) => `<li data-a="${k}">${fact(f)}</li>`).join('')}</ul></section>`).join('')
    : `<section class="card"><h3>Project facts</h3>${empty('No COORDINATOR.md in this project yet: /coordinator init writes it.')}</section>`;
  const ds = c.decisions.slice(0, 30);
  const decided = `<section class="card" data-a="mem-decisions"><h3>Your decisions <span class="chip">${c.decisions.length}</span></h3>`
    + (ds.length ? `<ul>${ds.map((d) => `<li data-a="dec-${esc(d.run)}-${esc(d.id)}-${esc(hash(d.answer))}"><b>${linkify(d.answer, null)}</b>${d.question ? ` <span class="cause">— ${esc(d.question)}</span>` : ''} <span class="cause">${runLink(d.run, ctx, m)} ${esc(d.id)}, ${stamp(d.at)}</span></li>`).join('')}</ul>`
      : empty('No answers from you yet.')) + '</section>';
  return `<p class="meta">What every run starts from: the project’s COORDINATOR.md, and the answers you gave in past runs.</p><div class="lists">${facts}${decided}</div>`;
}

function stats(m, ctx) {
  const s = m.stats;
  if (!s.units) return empty('No finished unit yet: the numbers start with the first pass or stop.');
  const c = s.closed;
  const basis = `<p class="meta">Counted over ${count(s.units, 'finished unit')} in all runs, open included. `
    + (c.runs ? `Closed runs only, as <code>run.mjs stats</code> counts: pass rate ${pct(c.passRate)}, rounds to pass median ${num(c.medianRoundsToPass)} (p80 ${num(c.p80RoundsToPass)}), stopped ${pct(c.stoppedShare)}${c.unfinished ? `, unfinished ${c.unfinished} (left open when the run closed: neither passed nor stopped)` : ''} of ${count(c.units, 'unit')} in ${count(c.runs, 'closed run')}.</p>`
      : 'No closed run yet, so <code>run.mjs stats</code> has nothing to count.</p>');
  const cards = basis + `<div class="budget">${stat('Pass rate', pct(s.passRate), 'Finished units that passed.')}`
    + stat('Rounds to pass', `${num(s.medianRoundsToPass)} <span class="cause">median · p80 ${num(s.p80RoundsToPass)}</span>`, 'Tries a passing unit needed.')
    + stat('Stopped', pct(s.stoppedShare), 'Finished units the rules stopped. Over 20% means the bars or splits need work.')
    + stat('Time per unit', num(s.minutesPerUnit, ' min'), 'Median, from a unit’s first build to its last verdict.')
    + `${s.suggestedMaxRounds ? stat('Suggested --max-rounds', s.suggestedMaxRounds, 'p80 rounds to pass, plus one, at most 8.') : ''}</div>`;
  const rows = s.trend.map((r) => `<tr data-a="tr-${esc(r.run)}"><th scope="row">${runLink(r.run, ctx, m)}</th><td>${r.passed}/${r.finished}</td><td>${pct(r.passRate)}${meter(r.passRate)}</td><td>${num(r.medianRounds)}</td><td>${num(r.minutesPerUnit, ' min')}</td></tr>`).join('');
  return `${cards}<h3 class="sub">Trend over runs</h3><div class="scroll"><table><thead><tr><th scope="col">Run</th><th scope="col">Passed</th><th scope="col">Pass rate</th><th scope="col">Median rounds</th><th scope="col">Time per unit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Units finished across runs (#36): each chain is one unit in the stats above.
function chains(m, ctx) {
  if (!m.chains?.length) return '';
  const rows = m.chains.map((c) => `<li data-a="chain-${esc(c.links[0].run)}-${esc(c.unit)}"><b>${esc(c.unit)}</b> ${c.links.map((l) => `${runLink(l.run, ctx, m)}${l.unit !== c.unit ? `<span class="cause">:${esc(l.unit)}</span>` : ''} <span class="cause">(${l.rounds} ${l.rounds === 1 ? 'try' : 'tries'}, ${esc(l.status)})</span>`).join(' → ')} · ${c.rounds} ${c.rounds === 1 ? 'round' : 'rounds'} ${chip(c.status, c.status)}</li>`).join('');
  return `<h3 class="sub">Work across runs</h3><p class="meta">A unit stopped in one run and finished in a follow-on run counts once in the stats, with its rounds added up.</p><ul class="plain">${rows}</ul>`;
}

function history(m, ctx) {
  if (!m.history.length) return m.chains?.length ? chains(m, ctx) : empty('No closed run yet.');
  const rows = m.history.map((h) => `<tr data-a="h-${esc(h.run)}"><th scope="row">${runLink(h.run, ctx, m)}<div class="cause">${esc(h.goal)}</div></th><td>${chip(h.outcome, h.outcome)}</td>`
    + `<td>${h.passed}/${h.units}${h.stopped ? ` <span class="cause">${h.stopped} stopped</span>` : ''}</td><td>${stamp(h.started)}</td><td>${stamp(h.closed)}</td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th scope="col">Run</th><th scope="col">Outcome</th><th scope="col">Units passed</th><th scope="col">Started</th><th scope="col">Closed</th></tr></thead><tbody>${rows}</tbody></table></div>${chains(m, ctx)}`;
}

function plans(m, ctx) {
  if (!m.plans.length) return empty('No open run.');
  return `<div class="grid">${m.plans.map((p) => {
    const left = p.left.length ? `<ul>${p.left.map((u) => `<li data-a="left-${esc(p.run)}-${esc(u.id)}">${u.dot ? `${unitDot(u)} ` : ''}<b>${esc(u.id)}</b>${u.title ? ` ${esc(u.title)}` : ''} ${stateChip(u, m.runIds.includes(p.run) ? { unitHref: unitHrefIn(ctx, p.run) } : null)} <span class="cause">waits on ${esc(u.waitsOn)}</span></li>`).join('')}</ul>` : empty('Nothing left: integration and the retro.');
    const needs = p.needsYou.length ? `<p class="from"><b>Needs you:</b> ${p.needsYou.map((q) => `${esc(q.id)} ${esc(q.text)}`).join(' · ')}</p>` : '';
    return `<section class="card" data-a="plan-${esc(p.run)}"><h3><span>${runLink(p.run, ctx, m)}${p.run === m.current ? ' <span class="cause">this dashboard</span>' : ''}</span>${chip(p.decision, p.decision)}</h3>`
      + `<p class="say">${esc(p.goal)}</p><div class="row"><span>${p.done} of ${count(p.total, 'unit')} finished</span></div>${meter(p.total ? Math.round((p.done / p.total) * 100) : 0)}`
      + `<div class="unit-next"><b>Next:</b> ${p.next.length ? esc(p.next.join(' · ')) : 'wait for the running agents'}</div>${needs}${left}</section>`;
  }).join('')}</div>`;
}

// Gaps: everything left undone across runs, grouped by run. The filter needs the live page's script;
// the snapshot lists them all. Resolved gaps stay listed, folded.
const GAP_BADGE = { stopped: 'stop', unfinished: 'fail', run: 'stop', 'follow-up': 'link', 'out-of-fence': 'strategy', upstream: 'merge', question: 'question', escape: 'fail' };
const GAP_CLIP = 220;
const gapsLine = (g) => `${count(g.openCount, 'open gap')} across ${count(g.openRuns, 'run')}`;
function gapItem(g, ctx, m) {
  const unit = g.unit ? (m.runIds.includes(g.run) ? ` · unit <a href="${esc(unitHrefIn(ctx, g.run)(g.unit))}">${esc(g.unit)}</a>` : ` · unit ${esc(g.unit)}`) : '';
  const long = g.text.length > GAP_CLIP;
  const text = long ? `${esc(clip(g.text, GAP_CLIP))}${toggle(`gap-${g.id}`, 'Full text', `<p class="say">${linkify(g.text, null)}</p>`)}` : linkify(g.text, null);
  const r = g.resolution;
  const res = r ? `<div class="cause"><b>Resolved</b> ${r.derived ? '(from the state)' : `by ${esc(r.by)}`}: ${linkify(r.reason, null)}${r.at ? ` · ${stamp(r.at)}` : ''}</div>` : '';
  return `<li data-a="gap-${esc(g.id)}" data-gap data-run="${esc(g.run)}" data-kind="${esc(g.kind)}">${badge(GAP_BADGE[g.kind] ?? 'info', KIND_LABEL[g.kind] ?? g.kind)} ${text}`
    + `${g.cause ? `<div class="cause">cause: ${esc(g.cause)}</div>` : ''}`
    + `<div class="cause">${runLink(g.run, ctx, m)}${unit}${g.at ? ` · ${stamp(g.at)}` : ''} · from ${esc(g.source)} · <code>${esc(g.id)}</code></div>${res}</li>`;
}
const gapGroups = (groups, ctx, m, status) => groups.map((grp) => `<section class="card gap-run" data-gap-group data-run="${esc(grp.run)}" data-status="${status}" data-a="gaps-${status}-${esc(grp.run)}"><h3><span>${runLink(grp.run, ctx, m)}</span><span class="chip" data-gap-n>${grp.items.length}</span></h3>`
  + `<ul class="plain">${grp.items.map((g) => gapItem(g, ctx, m)).join('')}</ul></section>`).join('');
function gapTools(g) {
  const opts = (vals, label) => vals.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
  return '<form class="tl-tools" data-gaps role="search">'
    + `<label>Run<select name="run"><option value="">All runs</option>${opts(g.runs, (v) => v)}</select></label>`
    + `<label>Kind<select name="kind"><option value="">All kinds</option>${opts(g.kinds, (v) => KIND_LABEL[v] ?? v)}</select></label>`
    + '<label>Status<select name="status"><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select></label>'
    + '<p class="cause" data-gaps-count aria-live="polite"></p></form>';
}
function gapsSection(m, ctx) {
  const g = m.gaps;
  if (!g.openCount && !g.resolvedCount) return empty('No gaps: no stopped or unfinished unit, open follow-up, question, escape or upstream proposal in any run.');
  const head = `<p class="meta"><b>${gapsLine(g)}</b> · ${g.resolvedCount} resolved. Stopped and unfinished units, runs closed early, follow-ups, out-of-fence items, questions for you, upstream proposals and escapes, from every run. `
    + 'Close one with <code>run.mjs gap close &lt;run&gt; &lt;id&gt; --reason R</code>: a decision in that run’s log.</p>';
  const open = g.openCount ? `<div class="lists gaps" data-gaps-open>${gapGroups(g.open, ctx, m, 'open')}</div>` : `<div data-gaps-open>${empty('No open gap.')}</div>`;
  const resolved = g.resolvedCount ? `<div data-gaps-resolved>${toggle('self-gaps-resolved', `Resolved · ${g.resolvedCount}`, `<div class="lists gaps">${gapGroups(g.resolved, ctx, m, 'resolved')}</div>`)}</div>` : '';
  return head + (ctx.live ? gapTools(g) : '') + open + resolved;
}

const PROPOSAL_BADGE = { upstream: 'merge', 'follow-up': 'link', retro: 'note', promote: 'pass' };
function proposals(m, ctx) {
  if (!m.proposals.length) return empty('No proposals yet. Follow-ups, retro notes and upstream notes from every run show here.');
  return `<p class="meta">Improvements for the skill (upstream) and the project (follow-ups), from retro notes, follow-ups and lessons seen 3 or more times.</p>`
    + `<ul class="plain">${keyed(m.proposals, (p) => `p-${p.kind}-${p.run}-${hash(p.text)}`).map(([p, k]) => `<li data-a="${esc(k)}">${badge(PROPOSAL_BADGE[p.kind] ?? 'info', p.kind)} ${linkify(p.text, null)}`
      + `<div class="cause">${p.run ? runLink(p.run, ctx, m) : ''}${p.at ? ` ${stamp(p.at)}` : ''}</div></li>`).join('')}</ul>`;
}

function study(m, ctx) {
  const s = m.study;
  const rule = '<p class="meta">While a run waits on builders or critics, the lead may send a low-cost researcher to study one topic relevant to the run (security, design and UX, the stack) and record lessons with sources. Each run has a cap. Nothing studied overrides the fence or the bar.</p>';
  const caps = s.runs.filter((r) => r.open || r.used).map((r) => `<div class="card" data-a="cap-${esc(r.run)}"><div class="row" style="margin:0"><span>${runLink(r.run, ctx, m)}</span><b>${r.used}/${r.cap}</b></div>${meter(r.cap ? Math.round((r.used / r.cap) * 100) : 100)}</div>`).join('');
  const log = s.log.length ? `<ul class="plain">${s.log.map((x) => `<li data-a="study-${esc(x.run)}-${esc(x.id)}">${badge(x.area === 'security' ? 'stop' : x.area === 'design' ? 'behaviour' : 'evidence', x.area)} <b>${esc(x.topic)}</b> ${linkify(x.text, null)}`
    + `<div class="cause">${runLink(x.run, ctx, m)} ${esc(x.id)} · ${stamp(x.at)} · sources ${sources(x.sources ?? []) || 'none'}${x.lessons?.length ? ` · lessons ${x.lessons.map(esc).join(', ')}` : ''}</div></li>`).join('')}</ul>`
    : empty('No study yet.');
  return rule + (caps ? `<div class="budget">${caps}</div>` : '') + log;
}

export const SECTIONS = [
  { id: 'age', title: 'Age', render: age },
  { id: 'plans', title: 'Plans', render: plans },
  { id: 'gaps', title: 'Gaps', render: gapsSection },
  { id: 'stats', title: 'Working stats', render: stats },
  { id: 'learning', title: 'Learning', render: learning },
  { id: 'memory', title: 'Memory', render: memory },
  { id: 'history', title: 'History', render: history },
  { id: 'proposals', title: 'Proposals', render: proposals },
  { id: 'study', title: 'Side study', render: study },
];

export function selfPage(m, nowMs = Date.now(), ctx) {
  const toc = `<nav class="toc" aria-label="Sections">${SECTIONS.map((s) => `<a href="#self-${s.id}">${esc(s.title)}${s.id === 'gaps' && m.gaps?.openCount ? ` · ${m.gaps.openCount}` : ''}</a>`).join('')}</nav>`;
  const body = [
    blk('head', `<header class="run"><h1>Coordinator</h1><span class="meta">across ${count(m.age.runs, 'run')} in this project${m.gaps?.openCount ? ` · <a href="#self-gaps">${gapsLine(m.gaps)}</a>` : ''} · updated ${stamp(new Date(nowMs).toISOString())}</span></header>`),
    toc,
    ...SECTIONS.map((s) => `<h2 id="self-${s.id}" data-a="h-${s.id}">${esc(s.title)}</h2>${blk(`self-${s.id}`, s.render(m, ctx), 'section', ` class="self" aria-labelledby="self-${s.id}"`)}`),
  ].join('\n');
  return page({ title: 'Coordinator', body, ctx, path: '/coordinator' });
}
