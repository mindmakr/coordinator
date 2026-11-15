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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadRunsIn } from './selfdata.mjs';
import { basename, join } from 'node:path';
import { linkedRuns } from './chain.mjs';
import { loadRun } from './events.mjs';
import { harnessName, origin, versionWarning } from './harness.mjs';
import { hud, originLine, progressBar, questionItem, runTabs, statusChip } from './hud.mjs';
import { repoFromText } from './links.mjs';
import { mapsPage } from './mapspage.mjs';
import { ageText } from './age.mjs';
import { blk, chip, esc, page, stamp, when } from './parts.mjs';
import { runStatus } from './progress.mjs';
import { needsAnchor } from './pcanswer.mjs';
import { doctorFile } from './doctorrecord.mjs';
import { projectName, questions } from './questions.mjs';
import { byProject, findEntry, registryFile, registryHome } from './registry.mjs';
import { reportPages } from './report/cli.mjs';
import { decide } from './rules.mjs';
import { isSafeId } from './store.mjs';
import { unitPage } from './unitpage.mjs';
import { VERSION } from './version.mjs';
import { view } from './view.mjs';

const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
export const PROJECT_PAGE = new RegExp(`^/p/([0-9a-f]{12})/run/(${ID})(/unit/${ID}|/maps|/report|/retro)?$`);
const runDirOf = (e, id = e.run) => join(e.stateDir, 'runs', id);
const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// One registered run, read now: its status (lib/progress.mjs) and origin (lib/harness.mjs), or why it could not be read.
function readEntry(e, nowMs) {
  try {
    const s = loadRun(runDirOf(e));
    const open = s.closed ? [] : questions(s, { project: projectName(e.stateDir) }).filter((q) => q.open);
    return { ...e, title: e.title ?? s.goal, alias: s.alias ?? e.alias, startedAt: s.createdAt ?? null, status: runStatus(s, s.closed ? null : decide(s, nowMs), { nowMs }), origin: origin(s), questions: open, repo: s.repo ?? null };
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
function timesLine(r, st, nowMs) {
  if (!valid(r.startedAt)) return '';
  const from = Date.parse(r.startedAt);
  const age = `<time datetime="${esc(r.startedAt)}" class="age" title="${esc(when(r.startedAt))}">${esc(ageText(nowMs - from))}</time>`;
  let end;
  if (st ? st.concluded : r.closed) end = valid(st?.closedAt) ? `ended ${stamp(st.closedAt, 'abs')} (took ${esc(ageText(Date.parse(st.closedAt) - from))})` : 'ended, time not recorded';
  else if (valid(st?.eta?.readyAt)) end = `ending about ${stamp(st.eta.readyAt, 'abs')}`;
  else end = `ending: ${esc(st?.eta?.short ?? 'no estimate yet')}`;
  return `<p class="cause times">started ${stamp(r.startedAt, 'abs')} · ${end} · age ${age}</p>`;
}

function runItem(r, ctx, nowMs = Date.now()) {
  const href = ctx.pcHref ? ctx.pcHref(r.key, r.run) : null;
  const name = href ? `<a href="${esc(href)}">${esc(r.run)}</a>` : esc(r.run);
  const alias = r.alias ? ` <span class="cause">“${esc(r.alias)}”</span>` : '';
  if (r.error) return `<li class="card run-row" data-a="pc-${esc(r.key)}-${esc(r.run)}"><h3><span>${name}${alias}</span></h3><p class="cause">${esc(r.error)}</p></li>`;
  const st = r.status;
  if (!st) {
    return `<li class="card run-row${r.closed ? ' fin' : ''}" data-a="pc-${esc(r.key)}-${esc(r.run)}"><h3><span>${name}${alias}</span>${chip(r.closed ? `closed: ${r.closed}` : 'open', r.closed ?? 'running')}</h3>`
      + `${r.title ? `<p class="cause">${esc(r.title)}</p>` : ''}${originLine({ ...r.origin, alias: null })}<p class="cause">last written ${stamp(r.lastSeen)}</p></li>`;
  }
  const body = st.concluded ? `<p class="say">${esc(String(st.reason).replace(/\.*$/, ''))}.</p>`
    : `<p class="say"><b>${esc(st.progress)}</b> · ${esc(st.doing)}</p>${progressBar(st, true)}<p class="cause">${esc(st.eta.text)}</p>`;
  return `<li class="card run-row${st.concluded ? ' fin' : ''}" data-a="pc-${esc(r.key)}-${esc(r.run)}"><h3><span>${name}${alias}</span>${statusChip(st)}</h3>`
    + `${timesLine(r, st, nowMs)}${r.title ? `<p class="cause">${esc(r.title)}</p>` : ''}${body}${originLine({ ...r.origin, alias: null })}<p class="cause">last written ${stamp(r.lastSeen)}</p></li>`;
}

const activeFirst = (r) => (r.status ? (r.status.concluded ? 1 : 0) : (r.closed ? 1 : 0));

// The "This PC" section: every registered run on this machine, grouped by project, this project first.
export function pcSection(m, ctx) {
  const pc = m.pc;
  if (!pc) return '<p class="empty">The register of runs on this PC was not read.</p>';
  if (!pc.groups.length) return '<p class="empty">No run registered on this PC yet. Every run.mjs write adds its run.</p>';
  const groups = [...pc.groups].sort((a, b) => (b.key === pc.here) - (a.key === pc.here));
  const active = (g) => g.runs.filter((r) => (r.status ? !r.status.concluded : !r.closed)).length;
  return `<p class="meta">${count(pc.runs, 'run')} in ${count(pc.groups.length, 'project')} on this PC, from every tool that ran the coordinator. This dashboard is skill ${esc(pc.version)}.</p>`
    + groups.map((g) => `<section class="card" data-a="pcg-${esc(g.key)}"><h3><span>${esc(g.name)}${g.key === pc.here ? ' <span class="cause">this project</span>' : ''}</span><span class="cause">${active(g)} active · ${g.runs.length} in all</span></h3>`
      + `<p class="cause" style="overflow-wrap:anywhere">${esc(g.project)}</p><ul class="plain run-rows">${[...g.runs].sort((a, b) => activeFirst(a) - activeFirst(b)).map((r) => runItem(r, ctx, pc.now)).join('')}</ul></section>`).join('');
}

// Needs you: every open question of every registered run, by project and run, each labelled with its
// project, run and task (questionLabel). ctx.answerForm ({ token }): the PC dashboard's answer form;
// without it the options are listed, read-only.
export function needsSection(pc, ctx = {}) {
  const groups = pc.groups.map((g) => ({ ...g, asking: g.runs.filter((r) => r.questions?.length) })).filter((g) => g.asking.length);
  if (!groups.length) return '<div class="needs calm">Nothing needs you on this PC.</div>';
  const runBlock = (r) => {
    const form = ctx.answerForm ? { ...ctx.answerForm, fields: [['key', r.key], ['run', r.run]] } : null;
    const href = ctx.pcHref ? ctx.pcHref(r.key, r.run) : null;
    const name = href ? `<a href="${esc(href)}">${esc(r.run)}</a>` : esc(r.run);
    const anchor = needsAnchor(r.key, r.run);
    return `<div class="needs" id="${esc(anchor)}" data-a="${esc(anchor)}"><b>${name}</b>${r.alias ? ` <span class="cause">“${esc(r.alias)}”</span>` : ''}`
      + `<ul>${r.questions.map((q) => questionItem(q, form, r.repo, `${r.key}-${r.run}-`)).join('')}</ul></div>`;
  };
  return groups.map((g) => `<section class="card" data-a="needs-g-${esc(g.key)}"><h3><span>${esc(g.name)}</span>`
    + `<span class="cause">${count(g.asking.reduce((n, r) => n + r.questions.length, 0), 'open question')}</span></h3>${g.asking.map(runBlock).join('')}</section>`).join('');
}

// Waiting on you (design one-boss 5.5): the open questions first, with their answer forms (needsSection),
// then the rest of what waits on the person (lib/waiting.mjs; its questions are those same forms, so they
// are not listed twice). Each item says how long it has waited; the live page keeps that current.
export function waitingSection(pc, waiting, ctx = {}) {
  const asking = pc.groups.some((g) => g.runs.some((r) => r.questions?.length));
  const rest = (waiting ?? []).filter((x) => x.kind !== 'question');
  if (!asking && !rest.length) return '<div class="needs calm">Nothing waits on you.</div>';
  const href = (x) => {
    if (!x.link) return null;
    if (x.link.startsWith('/#')) return x.link.slice(1);
    const sub = x.link.slice(`/p/${x.key}/run/${encodeURIComponent(x.run)}`.length);
    return ctx.pcHref ? ctx.pcHref(x.key, x.run, sub) : null;
  };
  const item = (x) => {
    const where = x.run ? `${esc(x.project)} · ${x.name ? `${esc(x.name)} ` : ''}(${esc(x.run)})` : 'this PC';
    const h = href(x);
    const since = x.since ? `<time datetime="${esc(x.since)}" class="age" title="${esc(when(x.since))}">${esc(ageText((pc.now ?? Date.now()) - Date.parse(x.since)))}</time> ago` : 'since unknown';
    const list = x.items?.length > 1 ? `<ul>${x.items.map((g) => `<li><span class="cause">${esc(g.id)}</span> ${esc(g.text)}</li>`).join('')}</ul>` : '';
    return `<li class="card" data-a="wait-${esc(x.kind)}-${esc(x.key ?? 'pc')}-${esc(x.run ?? 'plugin')}"><h3><span>${h ? `<a href="${esc(h)}">${where}</a>` : where}</span>${chip(x.what, x.kind === 'plugin' ? 'not-yet' : 'needs-you')}</h3>`
      + `<p class="say">${esc(x.text)}</p>${list}<p class="cause">waiting ${since}${x.fix ? ` · <code>${esc(x.fix)}</code>` : ''}</p></li>`;
  };
  const questionsPart = asking ? `<h3 id="pc-needs" data-a="h-pc-needs">Questions for you</h3>${needsSection(pc, ctx)}` : '';
  const restPart = rest.length ? `<h3 id="pc-loose" data-a="h-pc-loose">Loose ends · ${count(rest.length, 'item')}, oldest first</h3><ul class="plain run-rows">${rest.map(item).join('')}</ul>` : '';
  return questionsPart + restPart;
}

// The global dashboard's home page. waiting: lib/waiting.mjs waitingList, read now.
export function pcPage(pc, nowMs, ctx, waiting = []) {
  const tools = [...new Set(pc.groups.flatMap((g) => g.runs.map((r) => r.origin?.harness).filter(Boolean)))].map(harnessName);
  const body = [
    blk('head', `<header class="run"><h1>Coordinator · this PC</h1><span class="meta">${count(pc.runs, 'run')} in ${count(pc.groups.length, 'project')}${tools.length ? ` · from ${esc(tools.join(', '))}` : ''} · updated ${stamp(new Date(nowMs).toISOString())}</span></header>`),
    `<h2 id="pc-waiting" data-a="h-pc-waiting">Waiting on you</h2>${blk('pc-waiting', waitingSection(pc, waiting, ctx), 'section', ' aria-labelledby="pc-waiting"')}`,
    `<h2 id="self-pc" data-a="h-pc">Runs on this PC</h2>${blk('self-pc', pcSection({ pc }, ctx), 'section', ' class="self" aria-labelledby="self-pc"')}`,
  ].join('\n');
  return page({ title: 'This PC', body, ctx, path: '/' });
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
    // The run's tabs; the way back to the run list is the breadcrumb's This PC.
    pages: [...runTabs({ base, href: (p) => `${base}${p}?${t}` }), { ...home, tab: false }], pc: { label: 'This PC', href: home.href },
  };
}

// The runs and lessons a registered project's retro page reads: its own, never the served folder's.
export function sourceOf(stateDir) {
  const read = (f) => { try { const l = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } };
  return { runs: () => loadRunsIn(stateDir), lessons: () => ({ global: read(join(registryHome(), 'lessons.json')), project: read(join(stateDir, 'lessons.json')) }) };
}

// The page at one /p/… path, or null. entries: the register, read now; home: the nav entry back to the run list.
export function projectPage(path, live, entries, home, nowMs = Date.now()) {
  const m = PROJECT_PAGE.exec(path);
  if (!m) return null;
  const [, key, id, rest = '/'] = m;
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
