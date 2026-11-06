// Pieces shared by the dashboard (hud.mjs) and a unit's page (unitpage.mjs):
// the page shell, the brand, keyed blocks the live page patches in place,
// behaviours, evidence and timeline rows. All state text is escaped or linkified.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { anchor, esc, linkify } from './links.mjs';
import { css, DARK, LIGHT } from './theme.mjs';
import { BADGES, matches, RANGES } from './timeline.mjs';
import { VERSION } from './version.mjs';

export { esc };
const SHELL = readFileSync(new URL('./hud.template.html', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('./live.client.js', import.meta.url), 'utf8');

export const cls = (s) => String(s ?? '').toLowerCase().replace(/[^a-z-]/g, '');
export const when = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
// A time: ISO with UTC spelled out in the snapshot; the live page rewrites it in the viewer's zone.
export const stamp = (iso, cls = '') => (iso ? `<time datetime="${esc(iso)}"${cls ? ` class="${cls}"` : ''} title="${esc(when(iso))}">${esc(when(iso))}</time>` : '');
export const chip = (label, kind = '') => `<span class="chip${kind ? ` s-${cls(kind)}` : ''}">${esc(label)}</span>`;
export const badge = (b, label) => `<span class="badge k-${cls(b)}">${esc(label ?? b)}</span>`;

// A block the live page compares by hash and swaps only when it changed.
const hash = (s) => createHash('sha1').update(s).digest('base64url').slice(0, 10);
export const blk = (key, html, tag = 'div', attrs = '') => `<${tag} data-k="${esc(key)}" data-h="${hash(html)}"${attrs}>${html}</${tag}>`;
// A toggle whose open state the live page remembers.
export const toggle = (key, summary, body, cls2 = 'raw') => `<details class="${cls2}" data-d="${esc(key)}"><summary>${summary}</summary>${body}</details>`;

// Connected nodes: one hub, three ends. Neutral ink, so it sits on any theme.
const MARK = '<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 10 4.5 4.5M10 10l5.5-5.5M10 10v6"/></g><g fill="currentColor"><circle cx="10" cy="10" r="2.8"/><circle cx="4.5" cy="4.5" r="2"/><circle cx="15.5" cy="4.5" r="2"/><circle cx="10" cy="16.5" r="2"/></g>';
const markSvg = (size) => `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${MARK}</svg>`;
const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" style="color:#6b6b66">${MARK}</svg>`)}`;
export const brand = () => `<div class="brand">${markSvg(20)}<b>Coordinator</b><span>by ${anchor('https://github.com/mindmakr', 'mindmakr')}</span></div>`;
const footer = () => `<footer>Coordinator ${VERSION} · by ${anchor('https://github.com/mindmakr', 'mindmakr')} · ${anchor('https://github.com/mindmakr/coordinator', 'github.com/mindmakr/coordinator')}</footer>`;

// System, light or dark. Works without a script (CSS :has); the live page also remembers it.
const THEME_TOGGLE = '<fieldset class="themes"><legend class="sr">Colour theme</legend>'
  + ['system', 'light', 'dark'].map((t) => `<input type="radio" name="theme" id="theme-${t}" value="${t}"${t === 'system' ? ' checked' : ''}><label for="theme-${t}">${t[0].toUpperCase()}${t.slice(1)}</label>`).join('')
  + '</fieldset>';

export function csp(live) {
  return live
    ? `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'nonce-${live.nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'`
    : "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
}

// The whole page. `body` goes inside <main id="app">, which the live page patches.
export function page({ title, body, ctx, path }) {
  const live = ctx.live;
  const status = live ? '<span id="live" class="live" role="status" aria-live="polite" data-state="connecting">Connecting…</span>'
    : '<span class="live" data-state="snapshot">Snapshot · read-only</span>';
  const parts = {
    csp: csp(live && { nonce: esc(live.nonce) }), title: esc(title), favicon: FAVICON, theme: css(ctx.theme ?? { light: LIGHT, dark: DARK }),
    top: `<div class="top">${brand()}<div class="tools">${status}${THEME_TOGGLE}</div></div>`,
    body, footer: footer(),
    attrs: live ? ` data-run="${esc(ctx.run)}" data-path="${esc(path)}" data-token="${esc(live.token)}"` : '',
    script: live ? `<script nonce="${esc(live.nonce)}">const matches = ${matches.toString()};\n${CLIENT}</script>` : '',
  };
  return SHELL.replace(/\{\{(\w+)\}\}/g, (_, k) => parts[k] ?? '');
}

export function behaviourList(list, repo, evidence = [], ctx = null, key = '') {
  if (!list.length) return '<p class="empty">No behaviours yet.</p>';
  return `<ul class="behaviours">${list.map((b) => {
    const ev = ctx ? evidence.filter((e) => e.behaviour === b.id) : [];
    return `<li>${chip(b.status, b.status === 'unchecked' ? '' : b.status)} <b>${esc(b.id)}</b> ${linkify(b.text, repo)}`
      + `${b.evidence ? `<div class="bev">${linkify(b.evidence, repo)}</div>` : ''}`
      + `${ev.length ? evidenceList(ev, repo, ctx, `${key}-${b.id}`) : ''}</li>`;
  }).join('')}</ul>`;
}

const LONG = (t) => t.length > 1200 || t.split('\n').length > 12;

function evidenceItem(e, repo, ctx, key) {
  const head = `${badge('evidence', e.kind)}${e.behaviour ? ` <b>${esc(e.behaviour)}</b>` : ''} ${esc(e.label ?? '')}`;
  let body = '';
  if (e.text !== undefined) {
    const pre = `<pre>${linkify(e.text, repo)}</pre>`;
    body = LONG(e.text) ? toggle(`${key}-${e.id}`, `${esc(e.label ?? e.kind)} · ${e.text.split('\n').length} lines`, pre, 'raw pre') : pre;
  } else if (e.url) body = `<p>${linkify(e.url, repo)}</p>`;
  else if (e.file && e.type === 'image') {
    const src = ctx.embed ? ctx.embed(e.file) : ctx.artHref(e.file);
    const full = ctx.artHref(e.file);
    body = src ? `<a href="${esc(full)}" target="_blank" rel="noopener noreferrer"><img class="thumb" src="${esc(src)}" alt="${esc(e.label ?? 'screenshot')}" loading="lazy"></a>`
      : `<p><a href="${esc(full)}" target="_blank" rel="noopener noreferrer">Open the screenshot</a></p>`;
  } else if (e.file) body = `<p><a href="${esc(ctx.artHref(e.file))}" target="_blank" rel="noopener noreferrer">Open ${esc(e.file.split('/').pop())}</a></p>`;
  return `<li class="evidence"><div>${head} ${stamp(e.at, 'cause')}</div>${body}</li>`;
}

export const evidenceList = (list, repo, ctx, key) => (list.length ? `<ul class="evlist">${list.map((e) => evidenceItem(e, repo, ctx, key)).join('')}</ul>` : '');

export function eventRow(e, repo) {
  const score = e.score === null || e.score === undefined ? '' : ` · ${e.score}`;
  const cause = e.cause ? ` <span class="cause">cause: ${esc(e.cause)}</span>` : '';
  return `<li data-at="${esc(e.at)}" data-badge="${esc(e.badge)}" data-unit="${esc(e.unit ?? '')}">${stamp(e.at)}`
    + `<span>${badge(e.badge, e.label)}</span>`
    + `<span>${e.who ? `<b>${esc(e.who)}${esc(score)}</b> ` : ''}${linkify(e.text, repo)}${cause}</span></li>`;
}

// Search, kind chips, unit chips, range and sort: live page only (they need its script).
export function timelineTools(units = []) {
  const chips = (name, values) => values.map((v) => `<label class="fchip"><input type="checkbox" name="${name}" value="${esc(v)}"><span>${esc(v || 'run')}</span></label>`).join('');
  return '<form class="tl-tools" data-tl role="search">'
    + '<label class="grow">Search<input type="search" name="q" placeholder="Search the timeline"></label>'
    + `<label>When<select name="range">${RANGES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`
    + '<label>Order<select name="sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>'
    + `<fieldset><legend>Kinds</legend>${chips('kind', BADGES)}</fieldset>`
    + (units.length ? `<fieldset><legend>Units</legend>${chips('unit', ['', ...units])}</fieldset>` : '')
    + '<p class="cause" data-tl-count></p></form>';
}
