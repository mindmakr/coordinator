// The demo's own pages: the banner on every page, the sign-in picker that stands in
// for GitHub's, the controls that play GitHub's and the lead's part, and the outbox
// where alerts land instead of email, push and GitHub mentions. Drawn with the skill's
// page shell, so they look like the rest of the service.
import { blk, esc, page, stamp } from '../core.mjs';

export const BANNER_TEXT = 'Local demo — nothing here is real or shared';
const BTN = 'display:inline-block;padding:3px 12px;border-radius:999px;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600';
export const BANNER = `<div role="note" data-demo="banner" style="background:var(--wait-bg);color:var(--ink);border-bottom:2px solid var(--wait);padding:8px 16px;font-size:14px;line-height:1.6;text-align:center;overflow-wrap:anywhere">`
  + `<b>${esc(BANNER_TEXT)}.</b> Copies of your runs, a pretend GitHub, alerts kept on this page. `
  + `<a href="/login" style="${BTN}">Demo sign in</a> <a href="/demo">Demo controls</a> · <a href="/demo/outbox">Alerts outbox</a></div>`;

// The banner, first thing inside <body>.
export const withBanner = (html) => (/<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => `${m}${BANNER}`) : `${BANNER}${html}`);

const NAV = [{ path: '/', label: 'Projects', href: '/' }, { path: '/alerts', label: 'Alerts', href: '/alerts' }, { path: '/demo', label: 'Demo controls', href: '/demo' }, { path: '/demo/outbox', label: 'Outbox', href: '/demo/outbox' }];
const ctx = { live: null, theme: null, embed: null, pages: NAV };
const shell = (title, path, body) => page({ title, body: blk('head', `<header class="run"><h1>${esc(title)}</h1></header>`) + body, ctx, path });

// users: [{ login, label, can }]. Each choice goes back to the real sign-in callback with a code.
export function signInPage(users, back, state) {
  const href = (u) => `${back}?${new URLSearchParams({ code: u.login, state })}`;
  const cards = users.map((u) => `<div class="card"><h3>${esc(u.label)}</h3><p class="meta">${esc(u.can)}</p><p><a href="${esc(href(u))}" style="${BTN}">Sign in as ${esc(u.login)}</a></p></div>`).join('');
  return shell('Demo sign in', '/login', `<p>GitHub would ask you to authorise the App here. In the demo you pick a pretend person instead.</p>${blk('who', cards, 'div', ' class="grid"')}`);
}

const select = (name, options) => `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
const form = (action, inner, button) => `<form method="post" action="${action}" style="margin:.4em 0">${inner} <button type="submit">${esc(button)}</button></form>`;

// refs: ['owner/repo#n'] the runs link; open: [[repo, run]] open runs; flash: what the last control did.
export function controlsPage({ refs, open, flash = null }) {
  const pr = refs.length ? select('ref', refs.map((r) => [r, r])) : null;
  const none = '<p class="empty">None of the runs links an issue or pull request.</p>';
  const cards = [
    ['Simulate a push', 'The lead pulls the web\'s answers and notes into its copy, makes a pit stop, and GitHub tells the service the state branch moved. The service reads it again through the normal path.', form('/demo/push', '', 'Push')],
    ['A pull request is merged', 'GitHub says a linked pull request was merged (or closed). It shows in the run\'s timeline, the tracker comments, and as an alert for open runs.', pr ? form('/demo/merge', `${pr} ${select('how', [['merged', 'merged'], ['closed', 'closed without merging']])}`, 'Send') : none],
    ['Checks finish', 'GitHub says the checks on a linked pull request finished. Red checks on an open run send an alert.', pr ? form('/demo/checks', `${pr} ${select('conclusion', [['failure', 'failed'], ['success', 'passed']])}`, 'Send') : none],
    ['The lead asks a question', 'The lead parks a question on an open run and pushes. Everyone watching the repo gets a "needs you" alert, and the run page shows the answer form.', open.length ? form('/demo/ask', select('run', open.map(([repo, run]) => [`${repo} ${run}`, `${run} (${repo})`])), 'Ask') : '<p class="empty">No open runs: every copied run is finished.</p>'],
  ].map(([h, p, f]) => `<div class="card"><h3>${esc(h)}</h3><p class="meta">${esc(p)}</p>${f}</div>`).join('');
  const note = flash ? `<div class="goal"><p>${esc(flash)}</p></div>` : '';
  return shell('Demo controls', '/demo', `${note}<p>These play GitHub's and the lead's part. Everything happens on the demo's copies; the run folders you passed are never written.</p>${blk('controls', cards, 'div', ' class="grid"')}`);
}

// items: [{ at, channel, to, title, body }], newest first.
export function outboxPage(items) {
  const rows = items.map((x) => `<div class="card"><h3>${esc(x.title)}</h3><div class="row"><span>${esc(x.channel)} → ${esc(x.to)}</span><span>${stamp(new Date(x.at).toISOString())}</span></div><pre style="white-space:pre-wrap;overflow-wrap:anywhere;margin:.5em 0 0">${esc(x.body)}</pre></div>`).join('');
  return shell('Alerts outbox', '/demo/outbox', `<p>Alerts the service sent, kept here instead of going out as email, web push or a GitHub mention. Both pretend people watch every repo.</p>${blk('outbox', rows || '<p class="empty">Nothing sent yet. Try a control on <a href="/demo">Demo controls</a>.</p>')}`);
}
