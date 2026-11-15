// Every run on this PC (lib/registry.mjs), for the global dashboard (`run.mjs
// dashboard`, `/coordinator:dashboard`), the "This PC" section of the coordinator
// page and `run.mjs list --all`. Runs of other projects are read from their own
// state folders, read-only, and a path names a project only by its key in the register,
// never by a folder. The one write is an answer from the front page's Waiting on you
// (lib/pcanswer.mjs), recorded by `run.mjs answer` in that project's state folder.
//   GET /                                       this PC: Waiting on you (questions with forms, then the rest:
//                                               lib/waiting.mjs), then every registered run, grouped by project
//   POST /answer (key, run, q, choice, other)   an answer to an open question of a registered run
//   GET /p/<key>/run/<run>[/unit/<u>|/maps|/report|/retro]   one run's pages, read-only
//   GET /p/<key>/coordinator                    that project's coordinator page (lib/selfpage.mjs), read-only
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadRunsIn } from './selfdata.mjs';
import { basename, join } from 'node:path';
import { linkedRuns } from './chain.mjs';
import { loadRun } from './events.mjs';
import { harnessName, origin, versionWarning } from './harness.mjs';
import { hud, originLine, questionItem, statusChip } from './hud.mjs';
import { repoFromText } from './links.mjs';
import { mapsPage } from './mapspage.mjs';
import { ageText } from './age.mjs';
import { bar, blk, chip, cols, esc, heading, kpis, page, panel, rows, stamp, table, toneChip, when } from './parts.mjs';
import { runStatus } from './progress.mjs';
import { needsAnchor } from './pcanswer.mjs';
import { doctorFile } from './doctorrecord.mjs';
import { projectName, questions } from './questions.mjs';
import { byProject, findEntry, registryFile, registryHome } from './registry.mjs';
import { reportPages } from './report/cli.mjs';
import { selfModel } from './self.mjs';
import { selfPage } from './selfpage.mjs';
import { decide } from './rules.mjs';
import { isSafeId } from './store.mjs';
import { unitPage } from './unitpage.mjs';
import { VERSION } from './version.mjs';
import { view } from './view.mjs';

const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
export const PROJECT_PAGE = new RegExp(`^/p/([0-9a-f]{12})/(?:run/(${ID})(/unit/${ID}|/maps|/report|/retro)?|(coordinator))$`);
const runDirOf = (e, id = e.run) => join(e.stateDir, 'runs', id);
const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The units of an open run that wait on another unit (--after) that has not passed.
const blockedIn = (s) => (s.closed ? [] : s.units.filter((u) => u.after && !['pass', 'stopped'].includes(u.status))
  .map((u) => ({ id: u.id, title: u.title ?? null, after: u.after, afterStatus: s.units.find((x) => x.id === u.after)?.status ?? null }))
  .filter((b) => b.afterStatus !== 'pass'));

// One registered run, read now: its status (lib/progress.mjs), origin (lib/harness.mjs) and blocked units, or why it could not be read.
function readEntry(e, nowMs) {
  try {
    const s = loadRun(runDirOf(e));
    const open = s.closed ? [] : questions(s, { project: projectName(e.stateDir) }).filter((q) => q.open);
    return { ...e, title: e.title ?? s.goal, alias: s.alias ?? e.alias, startedAt: s.createdAt ?? null, status: runStatus(s, s.closed ? null : decide(s, nowMs), { nowMs }), origin: origin(s), questions: open, blocked: blockedIn(s), repo: s.repo ?? null };
  } catch (err) { return { ...e, error: `unreadable: ${err.message}` }; }
}

// The register, grouped by project, each run read. here: the state folder of the project being shown, if any.
// read: false keeps to what the register says (the snapshot's cheap path): no run is opened.
export function pcModel(entries, { nowMs = Date.now(), here = null, read = true } = {}) {
  const light = (e) => ({ ...e, origin: { line: e.startedIn ? `started in ${harnessName(e.startedIn)}` : 'tool not recorded', later: e.harness ? `last written in ${harnessName(e.harness)} · skill ${e.skill ?? 'unknown'}` : null, warning: versionWarning(e.skill) } });
  const groups = byProject(entries).map((g) => ({ ...g, name: basename(g.project), runs: g.runs.map((e) => (read ? readEntry(e, nowMs) : light(e))) }));
  const here_ = here ? groups.find((g) => g.runs.some((r) => r.stateDir === here) || g.stateDir === here) : null;
  return { groups, here: here_?.key ?? null, runs: entries.length, version: VERSION, file: registryFile(), now: nowMs };
}

// When a run started, when it ended or should end, and its age (start to now). Start and end show
// as clock times; the live page keeps the age current (lib/live.client.js, class "abs" and "age").
const valid = (iso) => typeof iso === 'string' && !Number.isNaN(Date.parse(iso));
function times(r, st, nowMs) {
  if (!valid(r.startedAt)) return { start: '', end: '' };
  const from = Date.parse(r.startedAt);
  const age = `<time datetime="${esc(r.startedAt)}" class="age" title="${esc(when(r.startedAt))}">${esc(ageText(nowMs - from))}</time>`;
  let end;
  if (st ? st.concluded : r.closed) end = valid(st?.closedAt) ? `ended ${stamp(st.closedAt, 'abs')} (took ${esc(ageText(Date.parse(st.closedAt) - from))})` : 'ended, time not recorded';
  else if (valid(st?.eta?.readyAt)) end = `ending about ${stamp(st.eta.readyAt, 'abs')}`;
  else end = `ending: ${esc(st?.eta?.short ?? 'no estimate yet')}`;
  return { start: `${stamp(r.startedAt, 'abs')}<div class="muted">age ${age}</div>`, end };
}

const isOver = (r) => (r.status ? r.status.concluded : !!r.closed);
const activeFirst = (r) => (isOver(r) ? 1 : 0);
const pcLink = (ctx, key, run, sub = '') => (ctx.pcHref ? ctx.pcHref(key, run, sub) : null);
const link = (href, label, cls = '') => (href ? `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}">${esc(label)}</a>` : esc(label));
// A registered project's coordinator page on a served page (/p/<key>/coordinator); a file on disk has none.
export const coordinatorHref = (ctx, key) => (ctx.live && key ? `/p/${key}/coordinator?t=${encodeURIComponent(ctx.live.token)}` : null);

// Every run of the register, flat, each with its project's name and whether it is the project shown.
const flat = (pc) => pc.groups.flatMap((g) => g.runs.map((r) => ({ r, name: g.name, here: g.key === pc.here })));

// One run as a table row: status, run, project and the tool it ran in, progress, what it does, its end, start and last write.
function runRow({ r, name, here }, ctx, nowMs) {
  const runCell = `${link(pcLink(ctx, r.key, r.run), r.run, 'mono')}${r.alias ? ` <span class="muted">“${esc(r.alias)}”</span>` : ''}${r.title ? `<div class="muted">${esc(r.title)}</div>` : ''}`;
  const project = `${esc(name)}${here ? ' <span class="muted">this project</span>' : ''}${r.origin ? originLine({ ...r.origin, alias: null }) : ''}`;
  const updated = { html: stamp(r.lastSeen) };
  if (r.error) return [{ html: toneChip('unreadable', 'bad') }, { html: runCell }, { html: project }, '', r.error, '', '', updated];
  const st = r.status;
  if (!st) return [{ html: chip(r.closed ? `closed: ${r.closed}` : 'open', r.closed ?? 'running') }, { html: runCell }, { html: project }, '', '', '', '', updated];
  const t = times(r, st, nowMs);
  const progress = `${esc(st.progress)}${bar(st.pct, { label: st.progress, tone: st.concluded ? '' : 'ok' })}`;
  return [{ html: statusChip(st) }, { html: runCell }, { html: project }, { html: progress }, st.concluded ? String(st.reason).replace(/\.*$/, '') : st.doing, { html: t.end }, { html: t.start }, updated];
}
const RUN_COLS = ['Status', 'Run', 'Project', 'Progress', 'Current', 'ETA', 'Started', 'Updated'].map((label) => ({ label }));
const runsTable = (list, ctx, nowMs, empty) => table({ cols: RUN_COLS, rows: list.map((x) => runRow(x, ctx, nowMs)), min: 980, max: 420, empty });

// The "This PC" runs: every registered run on this machine, active first, this project's first among equals.
export function pcSection(m, ctx) {
  const pc = m.pc;
  if (!pc) return '<p class="empty">The register of runs on this PC was not read.</p>';
  if (!pc.groups.length) return '<p class="empty">No run registered on this PC yet.</p>';
  const list = flat(pc).sort((a, b) => activeFirst(a.r) - activeFirst(b.r) || b.here - a.here);
  return `<p class="meta">${count(pc.runs, 'run')} in ${count(pc.groups.length, 'project')} · skill ${esc(pc.version)}</p>${runsTable(list, ctx, pc.now)}`;
}

// Needs you: every open question of every registered run, by project and run, each labelled with its
// project, run and task (questionLabel). ctx.answerForm ({ token }): the PC dashboard's answer form;
// without it the options are listed, read-only.
export function needsSection(pc, ctx = {}) {
  const groups = pc.groups.map((g) => ({ ...g, asking: g.runs.filter((r) => r.questions?.length) })).filter((g) => g.asking.length);
  if (!groups.length) return '<div class="needs calm">Nothing needs you on this PC.</div>';
  const runBlock = (r) => {
    const form = ctx.answerForm ? { ...ctx.answerForm, fields: [['key', r.key], ['run', r.run]] } : null;
    const name = link(pcLink(ctx, r.key, r.run), r.run);
    const anchor = needsAnchor(r.key, r.run);
    return `<div class="needs" id="${esc(anchor)}" data-a="${esc(anchor)}"><b>${name}</b>${r.alias ? ` <span class="cause">“${esc(r.alias)}”</span>` : ''}`
      + `<ul>${r.questions.map((q) => questionItem(q, form, r.repo, `${r.key}-${r.run}-`)).join('')}</ul></div>`;
  };
  return groups.map((g) => `<section class="card" data-a="needs-g-${esc(g.key)}"><h3><span>${esc(g.name)}</span>`
    + `<span class="cause">${count(g.asking.reduce((n, r) => n + r.questions.length, 0), 'open question')}</span></h3>${g.asking.map(runBlock).join('')}</section>`).join('');
}

// What waits on the person besides the open questions (lib/waiting.mjs; the questions have their forms in Questions).
const looseOf = (waiting) => (waiting ?? []).filter((x) => x.kind !== 'question');
const since = (x, nowMs) => (x.since ? `<time datetime="${esc(x.since)}" class="age" title="${esc(when(x.since))}">${esc(ageText(nowMs - Date.parse(x.since)))}</time> ago` : 'since unknown');

// Loose ends, oldest first: each says where, what, how long it has waited (the live page keeps that current) and the fix.
export function looseEnds(pc, waiting, ctx = {}) {
  const nowMs = pc.now ?? Date.now();
  const href = (x) => {
    if (!x.link) return null;
    if (x.link.startsWith('/#')) return x.link.slice(1);
    return pcLink(ctx, x.key, x.run, x.link.slice(`/p/${x.key}/run/${encodeURIComponent(x.run)}`.length));
  };
  const item = (x) => {
    const where = x.run ? `${x.project} · ${x.name ? `${x.name} ` : ''}(${x.run})` : 'this PC';
    const list = x.items?.length > 1 ? `<ul>${x.items.map((g) => `<li><span class="cause">${esc(g.id)}</span> ${esc(g.text)}</li>`).join('')}</ul>` : '';
    return `${toneChip(x.what, x.kind === 'plugin' ? '' : 'ask')}<span class="grow">${link(href(x), where)}<span class="line">${esc(x.text)}</span>${list}`
      + `<span class="muted">waiting ${since(x, nowMs)}${x.fix ? ` · <code>${esc(x.fix)}</code>` : ''}</span></span>`;
  };
  return rows(looseOf(waiting).map(item), { empty: 'Nothing waits on you.' });
}

// Units that wait on another unit of their run that has not passed.
function blockedRows(pc, ctx) {
  const list = flat(pc).filter(({ r }) => !isOver(r)).flatMap(({ r, name }) => (r.blocked ?? []).map((b) => ({ r, name, b })));
  return rows(list.map(({ r, name, b }) => `${toneChip(b.afterStatus === 'stopped' ? `${b.after} stopped` : `after ${b.after}`, b.afterStatus === 'stopped' ? 'bad' : '')}`
    + `<span class="grow">${link(pcLink(ctx, r.key, r.run), r.run, 'mono')} / ${link(pcLink(ctx, r.key, r.run, `/unit/${encodeURIComponent(b.id)}`), b.id, 'mono')}${b.title ? ` <span class="muted">${esc(b.title)}</span>` : ''}</span>`
    + `<span class="muted">${esc(name)}</span>`), { empty: 'No blocked unit.' });
}

// Concluded runs, latest first: outcome, run, project and when it ended.
function concludedRows(list, ctx, nowMs) {
  const end = ({ r }) => (r.status?.closedAt ?? r.lastSeen ?? '');
  return rows([...list].sort((a, b) => String(end(b)).localeCompare(String(end(a)))).map((x) => {
    const { r, name } = x;
    const t = times(r, r.status, nowMs);
    return `${r.status ? statusChip(r.status) : chip(`closed: ${r.closed}`, r.closed)}<span class="grow">${link(pcLink(ctx, r.key, r.run), r.run, 'mono')}`
      + `${r.alias ? ` <span class="muted">“${esc(r.alias)}”</span>` : ''} <span class="muted">${esc(name)}</span>${r.status?.reason ? `<span class="line muted">${esc(String(r.status.reason).replace(/\.*$/, ''))}</span>` : ''}</span>`
      + `<span class="muted">${t.end || (r.lastSeen ? `last written ${stamp(r.lastSeen)}` : '')}</span>`;
  }), { empty: 'No concluded run.' });
}

// The project whose coordinator page the tab opens: the one shown, else the one written to last.
function coordinatorKey(pc) {
  if (pc.here) return pc.here;
  const last = flat(pc).sort((a, b) => String(b.r.lastSeen ?? '').localeCompare(String(a.r.lastSeen ?? '')))[0];
  return last?.r.key ?? pc.groups[0]?.key ?? null;
}

// The coordinator in figures, and each project's coordinator page.
function coordinatorSummary(pc, active, tools, ctx) {
  const fig = (k, v) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  const figs = `<div class="figs">${fig('Runs', pc.runs)}${fig('Projects', pc.groups.length)}${fig('Active', active)}${fig('Skill', pc.version)}</div>`;
  const projects = rows(pc.groups.map((g) => `<span class="grow">${link(coordinatorHref(ctx, g.key), g.name)}</span>`
    + `<span class="muted">${count(g.runs.length, 'run')} · ${g.runs.filter((r) => !isOver(r)).length} active</span>`), { empty: 'No project.' });
  return `${figs}${tools.length ? `<p class="meta">Tools: ${esc(tools.join(', '))}</p>` : ''}${projects}`;
}

const sameDay = (iso, nowMs) => valid(iso) && new Date(iso).toDateString() === new Date(nowMs).toDateString();
const oldest = (list, nowMs) => { const t = list.map((x) => Date.parse(x.since)).filter(Number.isFinite); return t.length ? `oldest ${ageText(nowMs - Math.min(...t))}` : ''; };

// The global dashboard's home page. waiting: lib/waiting.mjs waitingList, read now.
export function pcPage(pc, nowMs, ctx, waiting = []) {
  const tools = [...new Set(pc.groups.flatMap((g) => g.runs.map((r) => r.origin?.harness).filter(Boolean)))].map(harnessName);
  const all = flat(pc);
  const active = all.filter(({ r }) => !isOver(r)).sort((a, b) => b.here - a.here);
  const over = all.filter(({ r }) => isOver(r));
  const asked = all.reduce((n, { r }) => n + (r.questions?.length ?? 0), 0);
  const askingRuns = active.filter(({ r }) => r.questions?.length || r.status?.kind === 'waiting').length;
  const today = over.filter(({ r }) => sameDay(r.status?.closedAt, nowMs));
  const loose = looseOf(waiting);
  const blocked = active.reduce((n, { r }) => n + (r.blocked?.length ?? 0), 0);
  const key = coordinatorKey(pc);
  const home = ctx.pages?.find((p) => p.path === '/') ?? { path: '/', label: 'This PC', href: ctx.home ?? '/' };
  const coord = coordinatorHref(ctx, key);
  const pages = [home, ...(coord ? [{ path: `/p/${key}/coordinator`, label: 'Coordinator', href: coord }] : [])];
  const sub = `${count(pc.runs, 'run')} · ${count(pc.groups.length, 'project')} · skill ${pc.version}${tools.length ? ` · ${tools.join(', ')}` : ''}`;
  const main = [
    panel({ id: 'pc-questions', title: 'Questions', count: asked, tone: asked ? 'ask' : '', bodyHtml: blk('pc-needs', needsSection(pc, ctx), 'section', ' id="pc-needs"') }),
    panel({ id: 'pc-runs', title: 'Runs', count: active.length, flush: active.length > 0, bodyHtml: blk('pc-runs', runsTable(active, ctx, nowMs, 'No active run.'), 'section', ' id="self-pc"') }),
    panel({ id: 'pc-blocked', title: 'Blocked units', count: blocked, bodyHtml: blk('pc-blocked', blockedRows(pc, ctx), 'section', ' id="pc-blocked"') }),
  ].join('');
  const side = [
    panel({ id: 'pc-loose', title: 'Loose ends', count: loose.length, bodyHtml: blk('pc-loose', looseEnds(pc, waiting, ctx), 'section', ' id="pc-loose"') }),
    panel({ id: 'pc-coordinator', title: 'Coordinator', metaHtml: coord ? `<a href="${esc(coord)}">Open</a>` : '', bodyHtml: blk('pc-coordinator', coordinatorSummary(pc, active.length, tools, ctx)) }),
    panel({ id: 'pc-concluded', title: 'Concluded', count: over.length, open: false, bodyHtml: blk('pc-concluded', concludedRows(over, ctx, nowMs), 'section', ' id="pc-concluded"') }),
  ].join('');
  const body = [
    blk('head', heading('This PC', sub)),
    blk('kpis', kpis([
      { k: 'Active', v: active.length, s: `${askingRuns} waiting on you` },
      { k: 'Questions', v: asked, s: oldest(waiting.filter((x) => x.kind === 'question'), nowMs) },
      { k: 'Finished today', v: today.length, s: today.length ? today.map(({ r }) => r.run).join(', ') : '' },
      { k: 'Loose ends', v: loose.length, s: oldest(loose, nowMs) },
    ])),
    cols(main, side),
  ].join('\n');
  return page({ title: 'This PC', body, ctx: { ...ctx, pages }, path: '/' });
}

// A served ctx for one run of a registered project, under /p/<key>/run/<id>: read-only, no forms, no stored files.
function projectCtx(live, key, id, home) {
  const t = `t=${encodeURIComponent(live.token)}`;
  const base = `/p/${key}/run/${encodeURIComponent(id)}`;
  return {
    live, theme: null, run: null, store: id, base, home: `${base}?${t}`, embed: null, readOnly: true,
    readOnlyHint: 'Read-only here. Answer an open question under Waiting on you on the This PC page, in that run\'s own dashboard (run.mjs serve), or in the lead\'s chat.',
    maps: `${base}/maps?${t}`, report: `${base}/report?${t}`, retro: `${base}/retro?${t}`,
    unitHref: (u) => `${base}/unit/${encodeURIComponent(u)}?${t}`,
    artHref: () => null, // stored files of other projects stay on disk: the page says "file kept locally"
    runHref: (other) => `/p/${key}/run/${encodeURIComponent(other)}?${t}`,
    pages: [{ path: base, label: id, href: `${base}?${t}` }, { path: `${base}/maps`, label: 'Maps', href: `${base}/maps?${t}` }, { path: `${base}/report`, label: 'Report', href: `${base}/report?${t}` }, { path: `${base}/retro`, label: 'Retro', href: `${base}/retro?${t}` }, home],
  };
}

// The runs and lessons a registered project's retro page reads: its own, never the served folder's.
export function sourceOf(stateDir) {
  const read = (f) => { try { const l = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } };
  return { runs: () => loadRunsIn(stateDir), lessons: () => ({ global: read(join(registryHome(), 'lessons.json')), project: read(join(stateDir, 'lessons.json')) }) };
}

// A registered project's coordinator page, read-only: its runs, lessons, COORDINATOR.md and last gaps check,
// read from its own folders as the snapshot reads them (lib/selfdata.mjs); the PC's runs from the register alone.
function projectCoordinator(key, live, entries, home, nowMs) {
  const e = entries.find((x) => x.key === key);
  if (!e || !existsSync(e.stateDir)) return null;
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
  let gapsCheck = null; try { gapsCheck = JSON.parse(read(join(e.stateDir, 'gaps-check.json'))); } catch { /* none yet */ }
  const src = sourceOf(e.stateDir);
  const m = { ...selfModel({ runs: src.runs(), lessons: src.lessons(), context: read(join(e.project, 'COORDINATOR.md')), gapsCheck, nowMs }), pc: pcModel(entries, { here: e.stateDir, nowMs, read: false }) };
  const t = `t=${encodeURIComponent(live.token)}`;
  const path = `/p/${key}/coordinator`;
  const runHref = (id) => `/p/${key}/run/${encodeURIComponent(id)}?${t}`;
  const ctx = {
    live, theme: null, run: null, store: null, base: path, home: home.href, embed: null, readOnly: true, path, project: basename(e.project),
    runHref, artHref: () => null, pcHref: (k, id, sub = '') => `/p/${k}/run/${encodeURIComponent(id)}${sub}?${t}`,
    pages: [home, { path, label: home.path === '/' ? 'Coordinator' : `Coordinator · ${basename(e.project)}`, href: `${path}?${t}` }],
  };
  return selfPage(m, nowMs, ctx);
}

// The page at one /p/… path, or null. entries: the register, read now; home: the nav entry back to the run list.
export function projectPage(path, live, entries, home, nowMs = Date.now()) {
  const m = PROJECT_PAGE.exec(path);
  if (!m) return null;
  const [, key, id, rest = '/', coordinator] = m;
  if (coordinator) return projectCoordinator(key, live, entries, home, nowMs);
  const e = findEntry(entries, key, id);
  if (!e || !isSafeId(id) || !existsSync(runDirOf(e))) return null;
  const s = loadRun(runDirOf(e));
  const sibling = (x) => { try { return isSafeId(x) && existsSync(runDirOf(e, x)) ? loadRun(runDirOf(e, x)) : null; } catch { return null; } };
  const v = view(s, decide(s, nowMs), nowMs, { repo: s.repo ?? repoFromText(JSON.stringify(s)), linked: linkedRuns(s, sibling), project: projectName(e.stateDir) });
  const ctx = { ...projectCtx(live, key, id, home), project: basename(e.project) };
  if (rest === '/maps') return mapsPage(v, nowMs, ctx);
  if (rest === '/report' || rest === '/retro') return reportPages(s, v, runDirOf(e), ctx, rest.slice(1), sourceOf(e.stateDir))[0][1];
  return rest === '/' ? hud(v, nowMs, ctx) : unitPage(v, decodeURIComponent(rest.slice('/unit/'.length)), nowMs, ctx);
}

// Changes when the register, any registered run or the stored doctor check changes: the live page's cue to re-render.
export function pcVersion(entries) {
  return [registryFile(), doctorFile(), ...entries.map((e) => join(runDirOf(e), 'state.json'))]
    .map((f) => { try { const st = statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');
}
