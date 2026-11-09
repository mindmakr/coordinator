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
      ALERTS,
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

// c12: Alerts (the person's own settings, /alerts) beside Projects for anyone signed in.
const ALERTS = { path: '/alerts', label: 'Alerts', href: '/alerts' };
const plainCtx = (user = null) => ({ live: null, theme: null, embed: null, pages: [{ path: '/', label: 'Projects', href: '/' }, ...(user ? [ALERTS] : [])] });

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

// The signed-out home: the homepage's message, short, inside this service's CSP (no script,
// no external font or image; inline styles and inline SVG only). The term lives in TERM.
const TERM = 'Lucid Coding';
const SITE = 'https://mindmakr.github.io/coordinator';
const LANDING_CSS = '<style>'
  + '.lx{padding:28px 0 8px;max-width:980px}'
  + '.lx-hero{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,4fr);gap:32px;align-items:center}'
  + '.lx h1{font-size:clamp(40px,8vw,68px);line-height:1;letter-spacing:-.035em;margin:0 0 10px;font-weight:800}'
  + '.lx-tag{font-size:clamp(20px,3.2vw,28px);margin:0 0 18px;color:var(--muted);font-weight:500;line-height:1.25}'
  + '.lx-tag a{color:var(--ink);font-weight:700;text-decoration-color:var(--run);text-decoration-thickness:3px;text-underline-offset:5px}'
  + '.lx-lede{font-size:18px;line-height:1.55;color:var(--muted);max-width:34em;margin:0 0 22px}'
  + '.lx-ctas{display:flex;flex-wrap:wrap;gap:10px}'
  + '.lx-btn{display:inline-block;background:var(--run);color:var(--card);font-weight:700;text-decoration:none;padding:12px 18px;border-radius:10px;white-space:nowrap}'
  + '.lx-btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}'
  + '.lx-btn:focus-visible,.lx a:focus-visible{outline:3px solid var(--run);outline-offset:3px}'
  + '.lx-ring{width:100%;max-width:260px;justify-self:center;color:var(--run)}'
  + '.lx-ring .t{fill:none;stroke:var(--line);stroke-width:3}'
  + '.lx-ring .p{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-dasharray:6;stroke-dashoffset:0;transform:rotate(-90deg);transform-origin:100px 100px}'
  + '.lx-ring circle.n{fill:var(--card);stroke:var(--line);stroke-width:2}'
  + '.lx-ring text{font:700 13px system-ui,sans-serif;fill:var(--muted);text-anchor:middle}'
  + '@media (prefers-reduced-motion:no-preference){.lx-ring .p{animation:lx-go 2.6s cubic-bezier(.22,.8,.2,1) .3s both}@keyframes lx-go{from{stroke-dashoffset:6}to{stroke-dashoffset:0}}}'
  + '.lx-points{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:34px 0 0;padding:0;list-style:none}'
  + '.lx-points li{border-top:2px solid var(--line);padding-top:10px;color:var(--muted);font-size:15px;line-height:1.5}'
  + '.lx-points b{display:block;color:var(--ink);font-size:16px;margin-bottom:2px}'
  + '.lx-foot{margin-top:28px;font-size:14px;color:var(--muted)}'
  + '@media (max-width:720px){.lx-hero{grid-template-columns:minmax(0,1fr)}.lx-ring{max-width:180px;justify-self:start}.lx-points{grid-template-columns:minmax(0,1fr)}}'
  + '</style>';
const LANDING_RING = '<svg class="lx-ring" viewBox="0 0 200 200" aria-hidden="true"><circle class="t" cx="100" cy="100" r="76"/><circle class="p" cx="100" cy="100" r="76" pathLength="6"/>'
  + [[100, 24], [166, 62], [166, 138], [100, 176], [34, 138], [34, 62]].map(([x, y], i) => `<circle class="n" cx="${x}" cy="${y}" r="12"/><text x="${x}" y="${y + 4.5}">${i + 1}</text>`).join('')
  + '<text x="100" y="97">builder</text><text x="100" y="114">≠ critic</text></svg>';

export function landing() {
  const body = LANDING_CSS + blk('head', '<section class="lx" aria-labelledby="lx-h">'
    + '<div class="lx-hero"><div>'
    + `<h1 id="lx-h">Coordinator</h1><p class="lx-tag"><a href="${SITE}/lucid-coding.html">${TERM}</a> for your agents</p>`
    + '<p class="lx-lede">Follow your runs from anywhere: how each agent read the problem, what it built, how a blind critic judged it and why, and what is running now. Answer the lead from your phone.</p>'
    + '<div class="lx-ctas"><a class="lx-btn" href="/login">Sign in with GitHub</a>'
    + `<a class="lx-btn ghost" href="${SITE}/#install">Install the skill</a></div>`
    + `</div>${LANDING_RING}</div>`
    + '<ul class="lx-points">'
    + '<li><b>Only what you can read</b>You see the runs of repos you can read on GitHub where the Coordinator App is installed, and nothing else.</li>'
    + '<li><b>Answer and get alerts</b>Answer questions and add notes here or in an issue comment; web push, email or a GitHub mention when a run needs you.</li>'
    + '<li><b>Work stays on your machine</b>Builders and critics run where you started them (and drive web and Expo apps locally with <a href="https://mindmakr.github.io/reins/">reins</a>). This site reads the run state your lead pushes at pit stops.</li>'
    + '</ul>'
    + `<p class="lx-foot"><a href="${SITE}/">What Coordinator is</a> · <a href="https://mindmakr.github.io/reins/">Companion: reins</a> · <a href="https://github.com/mindmakr/coordinator/blob/main/docs/privacy.md">What this service keeps</a> · Author: Asif Raja, by Mindmakr</p>`
    + '</section>');
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
  return withBar(page({ title: 'Projects', body, ctx: plainCtx(user), path: '/' }), user);
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

// action (optional): trusted HTML the caller built, e.g. a one-button form, shown under the text.
export function messagePage(title, text, user = null, back = null, action = '') {
  const body = blk('head', `<header class="run"><h1>${esc(title)}</h1></header>`) + `<section class="card"><p>${esc(text)}</p>${action}<p>${back ? `<a href="${esc(back)}">Back to the run</a> · ` : ''}<a href="/">Back to your projects</a></p></section>`;
  return withBar(page({ title, body, ctx: plainCtx(user), path: '' }), user);
}
