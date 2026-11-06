// Server-side pages from the read model, drawn by the skill's own renderers
// (hud, unitPage, selfPage, page) so a run looks the same here as on the
// local dashboard. No scripts. The run and unit pages carry the answer and
// note forms (c12), posting to /run/<run>/answer|note; disabled, with the
// reason, for people who cannot push to the repo. Every
// string from a run is escaped by those renderers; the few bits drawn here use
// the same esc().
import { blk, chip, decide, esc, hud, mapsPage, page, projectMapPage, runView, selfModel, selfPage, stamp, unitPage } from './core.mjs';

const enc = encodeURIComponent;
export const repoBase = (fullName) => `/r/${fullName.split('/').map(enc).join('/')}`;

// Extra pages, by path segment. scope 'repo': /r/<owner>/<repo>/<id>, render(user, repo, rows, nowMs);
// scope 'run': /r/<owner>/<repo>/run/<run>/<id>, render(user, repo, row, nowMs), shown when has(row).
export const REPO_PAGES = {
  coordinator: { scope: 'repo', label: 'Coordinator', render: (user, repo, rows, nowMs) => coordinatorPage(user, repo, rows, nowMs) },
  map: { scope: 'run', label: 'Project map', has: (row) => !!(row.map || row.mapError), render: (user, repo, row) => projectMapView(user, repo, row) },
};

export const READ_ONLY_HINT = 'Answer on the run’s page, or in the chat with the lead.';

// c12: the forms for a viewer whose push access was checked (user.write: { ok, reason }).
const formFor = (user, runBase) => (user?.write && runBase ? { token: user.csrf, tokenName: 'csrf', post: runBase, disabled: user.write.ok ? null : user.write.reason } : null);

function ctxFor(fullName, run = null, row = null, user = null) {
  const base = repoBase(fullName);
  const runBase = run ? `${base}/run/${enc(run)}` : null;
  const form = formFor(user, runBase);
  return {
    live: null, form, theme: null, run, store: run, base: runBase ?? base, home: runBase ?? base, embed: null, readOnly: !form,
    readOnlyHint: READ_ONLY_HINT,
    maps: runBase ? `${runBase}/maps` : null,
    mapHref: runBase && row && REPO_PAGES.map.has(row) ? `${runBase}/map` : null,
    runHref: (id) => `${base}/run/${enc(id)}`,
    unitHref: (id) => `${runBase}/unit/${enc(id)}`,
    // Evidence files never leave the person's machine (durability.md): shown as "file kept locally".
    artHref: () => null,
    pages: [
      { path: '/', label: 'Projects', href: '/' },
      { path: base, label: fullName, href: base },
      ...(run ? [{ path: runBase, label: run, href: runBase }, { path: `${runBase}/maps`, label: 'Maps', href: `${runBase}/maps` }] : []),
      ...(run && row ? Object.entries(REPO_PAGES).filter(([, p]) => p.scope === 'run' && p.has(row)).map(([id, p]) => ({ path: `${runBase}/${id}`, label: p.label, href: `${runBase}/${id}` })) : []),
      ...Object.entries(REPO_PAGES).filter(([, p]) => p.scope === 'repo').map(([id, p]) => ({ path: id === 'coordinator' ? '/coordinator' : `${base}/${id}`, label: p.label, href: `${base}/${id}` })),
    ],
  };
}

// GitHub's own events for the units' issues and PRs (merged, closed, checks), as timeline rows.
// gh: [{ unit, events: [{ kind, at, detail }] }], already limited to what the viewer may read.
const BADGE = { merged: 'merge', closed: 'info', reopened: 'info' };
export function withGitHub(v, gh = []) {
  if (!gh.length) return v;
  const rows = gh.flatMap(({ unit, events }) => events.map((e) => {
    const failed = e.kind === 'checks' && e.detail?.conclusion !== 'success';
    return {
      at: e.at, unit, who: unit, score: null, cause: null,
      badge: e.kind === 'checks' ? (failed ? 'fail' : 'pass') : BADGE[e.kind] ?? 'info',
      label: e.kind === 'checks' ? (failed ? 'checks red' : 'checks green') : e.kind,
      text: `${e.detail?.label ?? 'PR'} ${e.kind === 'checks' ? `checks ${e.detail?.conclusion ?? 'finished'}` : e.kind} (GitHub)`,
    };
  }));
  const byTime = (a, b) => String(a.at).localeCompare(String(b.at));
  return {
    ...v,
    timeline: [...v.timeline, ...rows].sort((a, b) => byTime(b, a)),
    units: v.units.map((u) => ({ ...u, timeline: [...u.timeline, ...rows.filter((r) => r.unit === u.id)].sort(byTime) })),
  };
}

const plainCtx = () => ({ live: null, theme: null, embed: null, pages: [{ path: '/', label: 'Projects', href: '/' }] });

// Who is signed in, and the only two forms: sign out and (on a repo) sync now.
function bar(user, repo = null) {
  if (!user) return '<p class="meta"><a href="/login">Sign in with GitHub</a></p>';
  const sync = repo ? `<form method="post" action="${esc(repoBase(repo))}/sync" style="display:inline"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><button type="submit">Sync now</button></form> ` : '';
  return `<div class="row" style="margin:0 0 12px"><span>Signed in as <b>${esc(user.login)}</b>${user.write ? (user.write.ok ? ' · can answer' : ' · read-only') : ''}</span><span>${sync}`
    + `<form method="post" action="/logout" style="display:inline"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><button type="submit">Sign out</button></form></span></div>`;
}
const withBar = (html, user, repo) => html.replace('<main id="app">', () => `<main id="app">${bar(user, repo)}`);

const runState = (row) => row.state;
const syncNote = (repo) => (repo.error ? `<p class="meta">Last sync: ${esc(repo.error)}</p>` : '');

export function landing() {
  const body = blk('head', '<header class="run"><h1>Coordinator</h1></header>')
    + '<section class="card"><p>Follow your coordinator runs from anywhere. Sign in with GitHub: you see the runs of every repo you can read where the Coordinator App is installed, and nothing else.</p>'
    + '<p><a href="/login">Sign in with GitHub</a></p></section>';
  return page({ title: 'Sign in', body, ctx: plainCtx(), path: '/' });
}

export function projectsPage(user, repos, { counts = new Map(), installUrl = null } = {}) {
  const cards = repos.map((r) => {
    const c = counts.get(`${r.installationId}:${r.id}`) ?? { runs: 0, open: 0, needs: 0 };
    return `<div class="card" data-a="p-${esc(r.fullName)}"><h3><a href="${esc(repoBase(r.fullName))}">${esc(r.fullName)}</a>${c.needs ? chip(`${c.needs} need you`, 'fail') : ''}</h3>`
      + `<div class="row"><span>${c.runs} run${c.runs === 1 ? '' : 's'}, ${c.open} open</span><span>${r.syncedAt ? `synced ${stamp(r.syncedAt)}` : 'not synced yet'}</span></div>${syncNote(r)}</div>`;
  }).join('');
  const none = `<p class="empty">No projects yet. A project appears here once the Coordinator App is installed on its repo and a run has been pushed to its coordinator-state branch${installUrl ? ` (<a href="${esc(installUrl)}">install the App</a>)` : ''}.</p>`;
  const body = blk('head', '<header class="run"><h1>Projects</h1><span class="meta">repos you can read on GitHub</span></header>')
    + blk('projects', cards || none, 'div', ' class="grid"');
  return withBar(page({ title: 'Projects', body, ctx: plainCtx(), path: '/' }), user);
}

export function runsPage(user, repo, rows, nowMs = Date.now()) {
  const ctx = ctxFor(repo.fullName);
  const cards = rows.map((row) => {
    if (!row.state) return `<div class="card"><h3>${esc(row.runId)}${chip('unreadable', 'fail')}</h3><p class="meta">${esc(row.error ?? '')}</p></div>`;
    const s = runState(row);
    const v = runView(s, decide(s), nowMs, { repo: repo.fullName });
    const passed = v.units.filter((u) => u.status === 'pass').length;
    return `<div class="card${v.open ? '' : ' fin'}" data-a="run-${esc(row.runId)}"><h3><a href="${esc(ctx.runHref(row.runId))}">${esc(row.runId)}</a>${chip(v.phase, v.open ? v.phase : v.phase.replace(/^closed: /, ''))}</h3>`
      + `<p class="say">${esc(v.situation.text)}</p>`
      + `<div class="row"><span>${passed}/${v.units.length} units passed${v.needsYou.length ? ` · <b>${v.needsYou.length} need you</b>` : ''}</span><span>started ${stamp(v.started)}</span></div>`
      + (row.error ? `<p class="meta">The latest log was refused, showing the last good copy: ${esc(row.error)}</p>` : '') + '</div>';
  });
  const pick = (test) => cards.filter((_, i) => test(rows[i].state));
  const unreadable = pick((s) => !s);
  const body = blk('head', `<header class="run"><h1>${esc(repo.fullName)}</h1><span class="meta">${rows.length} run${rows.length === 1 ? '' : 's'} · ${repo.syncedAt ? `synced ${stamp(repo.syncedAt)}` : 'not synced yet'}</span></header>`)
    + syncNote(repo)
    + '<h2>Open</h2>' + blk('open', pick((s) => s && !s.closed).join('') || '<p class="empty">No open runs.</p>', 'div', ' class="grid"')
    + '<h2>Finished</h2>' + blk('closed', pick((s) => s?.closed).join('') || '<p class="empty">None yet.</p>', 'div', ' class="grid"')
    + (unreadable.length ? `<h2>Unreadable</h2>${blk('bad', unreadable.join(''), 'div', ' class="grid"')}` : '');
  return withBar(page({ title: repo.fullName, body, ctx, path: ctx.base }), user, repo.fullName);
}

const viewOf = (repo, row, nowMs, gh) => { const s = runState(row); return withGitHub(runView(s, decide(s), nowMs, { repo: repo.fullName }), gh); };

export function runPage(user, repo, row, nowMs = Date.now(), gh = []) {
  return withBar(hud(viewOf(repo, row, nowMs, gh), nowMs, ctxFor(repo.fullName, row.runId, row, user)), user, repo.fullName);
}

export function unitView(user, repo, row, unitId, nowMs = Date.now(), gh = []) {
  const html = unitPage(viewOf(repo, row, nowMs, gh), unitId, nowMs, ctxFor(repo.fullName, row.runId, row, user));
  return html === null ? null : withBar(html, user, repo.fullName);
}

export function mapsView(user, repo, row, nowMs = Date.now(), gh = []) {
  return withBar(mapsPage(viewOf(repo, row, nowMs, gh), nowMs, ctxFor(repo.fullName, row.runId, row)), user, repo.fullName);
}

// The run's project map (lib/map/page.mjs), from the copy the run pushed. A log that never
// replayed shows why, as the local dashboard does; one that broke later keeps the last good map.
export function projectMapView(user, repo, row) {
  const ctx = ctxFor(repo.fullName, row.runId, row);
  if (!row.map) {
    const body = `<a class="back" href="${esc(ctx.home)}">← ${esc(row.runId)} dashboard</a><header class="run"><h1>Project map · not readable</h1></header>`
      + `<div class="needs"><p><b>The map's log could not be read.</b></p><p>${esc(row.mapError ?? '')}</p></div>`;
    return withBar(page({ title: `Map · ${row.runId}`, body, ctx, path: `${ctx.base}/map` }), user, repo.fullName);
  }
  const html = projectMapPage(row.map, ctx, row.runId);
  const note = row.mapError ? `<p class="meta">The latest map log was refused, showing the last good copy: ${esc(row.mapError)}</p>` : '';
  return withBar(html.replace('<main id="app">', () => `<main id="app">${note}`), user, repo.fullName);
}

export function coordinatorPage(user, repo, rows, nowMs = Date.now()) {
  const runs = rows.map(runState).filter(Boolean);
  const m = selfModel({ runs, lessons: { global: [], project: repo.lessons ?? [] }, context: null, current: null, nowMs });
  return withBar(selfPage(m, nowMs, ctxFor(repo.fullName)), user, repo.fullName);
}

export function messagePage(title, text, user = null, back = null) {
  const body = blk('head', `<header class="run"><h1>${esc(title)}</h1></header>`) + `<section class="card"><p>${esc(text)}</p><p>${back ? `<a href="${esc(back)}">Back to the run</a> · ` : ''}<a href="/">Back to your projects</a></p></section>`;
  return withBar(page({ title, body, ctx: plainCtx(), path: '' }), user);
}
