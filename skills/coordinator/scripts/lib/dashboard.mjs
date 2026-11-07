// Every run on this PC (lib/registry.mjs), for the global dashboard (`run.mjs
// dashboard`, `/coordinator:dashboard`), the "This PC" section of the coordinator
// page and `run.mjs list --all`. Runs of other projects are read from their own
// state folders, read-only: a page here never writes, and a path names a project
// only by its key in the register, never by a folder.
//   GET /                                       this PC: every registered run, grouped by project
//   GET /p/<key>/run/<run>[/unit/<u>|/maps|/report|/retro]   one run's pages, read-only
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { linkedRuns } from './chain.mjs';
import { loadRun } from './events.mjs';
import { harnessName, origin, versionWarning } from './harness.mjs';
import { hud, originLine, progressBar, statusChip } from './hud.mjs';
import { repoFromText } from './links.mjs';
import { mapsPage } from './mapspage.mjs';
import { blk, chip, esc, page, stamp } from './parts.mjs';
import { runStatus } from './progress.mjs';
import { byProject, findEntry, registryFile } from './registry.mjs';
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
    return { ...e, title: e.title ?? s.goal, alias: s.alias ?? e.alias, status: runStatus(s, s.closed ? null : decide(s, nowMs), { nowMs }), origin: origin(s) };
  } catch (err) { return { ...e, error: `unreadable: ${err.message}` }; }
}

// The register, grouped by project, each run read. here: the state folder of the project being shown, if any.
// read: false keeps to what the register says (the snapshot's cheap path): no run is opened.
export function pcModel(entries, { nowMs = Date.now(), here = null, read = true } = {}) {
  const light = (e) => ({ ...e, origin: { line: e.startedIn ? `started in ${harnessName(e.startedIn)}` : 'tool not recorded', later: e.harness ? `last written in ${harnessName(e.harness)} · skill ${e.skill ?? 'unknown'}` : null, warning: versionWarning(e.skill) } });
  const groups = byProject(entries).map((g) => ({ ...g, name: basename(g.project), runs: g.runs.map((e) => (read ? readEntry(e, nowMs) : light(e))) }));
  const here_ = here ? groups.find((g) => g.runs.some((r) => r.stateDir === here) || g.stateDir === here) : null;
  return { groups, here: here_?.key ?? null, runs: entries.length, version: VERSION, file: registryFile() };
}

function runItem(r, ctx) {
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
    + `${r.title ? `<p class="cause">${esc(r.title)}</p>` : ''}${body}${originLine({ ...r.origin, alias: null })}<p class="cause">last written ${stamp(r.lastSeen)}</p></li>`;
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
      + `<p class="cause" style="overflow-wrap:anywhere">${esc(g.project)}</p><ul class="plain run-rows">${[...g.runs].sort((a, b) => activeFirst(a) - activeFirst(b)).map((r) => runItem(r, ctx)).join('')}</ul></section>`).join('');
}

// The global dashboard's home page.
export function pcPage(pc, nowMs, ctx) {
  const tools = [...new Set(pc.groups.flatMap((g) => g.runs.map((r) => r.origin?.harness).filter(Boolean)))].map(harnessName);
  const body = [
    blk('head', `<header class="run"><h1>Coordinator · this PC</h1><span class="meta">${count(pc.runs, 'run')} in ${count(pc.groups.length, 'project')}${tools.length ? ` · from ${esc(tools.join(', '))}` : ''} · updated ${stamp(new Date(nowMs).toISOString())}</span></header>`),
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
    readOnlyHint: 'Read-only here. Answer in that run\'s own dashboard (run.mjs serve), or in the lead\'s chat.',
    maps: `${base}/maps?${t}`, report: `${base}/report?${t}`, retro: `${base}/retro?${t}`,
    unitHref: (u) => `${base}/unit/${encodeURIComponent(u)}?${t}`,
    artHref: () => null, // stored files of other projects stay on disk: the page says "file kept locally"
    runHref: (other) => `/p/${key}/run/${encodeURIComponent(other)}?${t}`,
    pages: [{ path: base, label: id, href: `${base}?${t}` }, { path: `${base}/maps`, label: 'Maps', href: `${base}/maps?${t}` }, { path: `${base}/report`, label: 'Report', href: `${base}/report?${t}` }, { path: `${base}/retro`, label: 'Retro', href: `${base}/retro?${t}` }, home],
  };
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
  const v = view(s, decide(s, nowMs), nowMs, { repo: s.repo ?? repoFromText(JSON.stringify(s)), linked: linkedRuns(s, sibling) });
  const ctx = projectCtx(live, key, id, home);
  if (rest === '/maps') return mapsPage(v, nowMs, ctx);
  if (rest === '/report' || rest === '/retro') return reportPages(s, v, runDirOf(e), ctx, rest.slice(1))[0][1];
  return rest === '/' ? hud(v, nowMs, ctx) : unitPage(v, decodeURIComponent(rest.slice('/unit/'.length)), nowMs, ctx);
}

// Changes when the register or any registered run changes: the live page's cue to re-render.
export function pcVersion(entries) {
  return [registryFile(), ...entries.map((e) => join(runDirOf(e), 'state.json'))]
    .map((f) => { try { const st = statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');
}
