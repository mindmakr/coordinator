// Server-side pages from the read model, drawn by the skill's own renderers
// (hud, unitPage, selfPage, page) so a run looks the same here as on the
// local dashboard. Read-only: no answer forms (that is c12), no scripts. Every
// string from a run is escaped by those renderers; the few bits drawn here use
// the same esc().
import { blk, chip, decide, esc, hud, page, runView, selfModel, selfPage, stamp, unitPage } from './core.mjs';

const enc = encodeURIComponent;
export const repoBase = (fullName) => `/r/${fullName.split('/').map(enc).join('/')}`;

function ctxFor(fullName, run = null) {
  const base = repoBase(fullName);
  const runBase = run ? `${base}/run/${enc(run)}` : null;
  return {
    live: null, theme: null, run, store: run, base: runBase ?? base, home: runBase ?? base, embed: null, readOnly: true,
    runHref: (id) => `${base}/run/${enc(id)}`,
    unitHref: (id) => `${runBase}/unit/${enc(id)}`,
    // Evidence files never leave the person's machine (durability.md), so there is nothing to open here.
    artHref: () => '#evidence-is-local',
    pages: [
      { path: '/', label: 'Projects', href: '/' },
      { path: base, label: fullName, href: base },
      ...(run ? [{ path: runBase, label: run, href: runBase }] : []),
      { path: '/coordinator', label: 'Coordinator', href: `${base}/coordinator` },
    ],
  };
}

const plainCtx = () => ({ live: null, theme: null, embed: null, pages: [{ path: '/', label: 'Projects', href: '/' }] });

// Who is signed in, and the only two forms: sign out and (on a repo) sync now.
function bar(user, repo = null) {
  if (!user) return '<p class="meta"><a href="/login">Sign in with GitHub</a></p>';
  const sync = repo ? `<form method="post" action="${esc(repoBase(repo))}/sync" style="display:inline"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><button type="submit">Sync now</button></form> ` : '';
  return `<div class="row" style="margin:0 0 12px"><span>Signed in as <b>${esc(user.login)}</b> · read-only</span><span>${sync}`
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

export function runPage(user, repo, row, nowMs = Date.now()) {
  const s = runState(row);
  const v = runView(s, decide(s), nowMs, { repo: repo.fullName });
  return withBar(hud(v, nowMs, ctxFor(repo.fullName, row.runId)), user, repo.fullName);
}

export function unitView(user, repo, row, unitId, nowMs = Date.now()) {
  const s = runState(row);
  const v = runView(s, decide(s), nowMs, { repo: repo.fullName });
  const html = unitPage(v, unitId, nowMs, ctxFor(repo.fullName, row.runId));
  return html === null ? null : withBar(html, user, repo.fullName);
}

export function coordinatorPage(user, repo, rows, nowMs = Date.now()) {
  const runs = rows.map(runState).filter(Boolean);
  const m = selfModel({ runs, lessons: { global: [], project: repo.lessons ?? [] }, context: null, current: null, nowMs });
  return withBar(selfPage(m, nowMs, ctxFor(repo.fullName)), user, repo.fullName);
}

export function messagePage(title, text, user = null) {
  const body = blk('head', `<header class="run"><h1>${esc(title)}</h1></header>`) + `<section class="card"><p>${esc(text)}</p><p><a href="/">Back to your projects</a></p></section>`;
  return withBar(page({ title, body, ctx: plainCtx(), path: '' }), user);
}
