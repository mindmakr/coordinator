// Pieces shared by the dashboard (hud.mjs) and a unit's page (unitpage.mjs):
// the page shell, the brand, keyed blocks the live page patches in place,
// behaviours, evidence and timeline rows. All state text is escaped or linkified.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { anchor, esc, linkify } from './links.mjs';
import { css, DARK, LIGHT } from './theme.mjs';
import { findMatches, highlight, unhighlight } from './highlight.mjs';
import { morph } from './morph.mjs';
import { DOTS, dotWords } from './plain.mjs';
import { BADGES, matches, RANGES } from './timeline.mjs';
import { VERSION } from './version.mjs';

export { esc };
const SHELL = readFileSync(new URL('./hud.template.html', import.meta.url), 'utf8');
// The live page's script: updates, then the map panels (lib/maptips.mjs), then walking a map (lib/mapnav.mjs).
const CLIENT = ['./live.client.js', './maptips.client.js', './mapnav.client.js'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
// Pure functions the page runs from the same source the tests check.
const SERVED = [matches, morph, findMatches, highlight, unhighlight];

export const cls = (s) => String(s ?? '').toLowerCase().replace(/[^a-z-]/g, '');
export const when = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
// A time: ISO with UTC spelled out in the snapshot; the live page rewrites it in the viewer's zone.
export const stamp = (iso, cls = '') => (iso ? `<time datetime="${esc(iso)}"${cls ? ` class="${cls}"` : ''} title="${esc(when(iso))}">${esc(when(iso))}</time>` : '');
export const chip = (label, kind = '') => `<span class="chip${kind ? ` s-${cls(kind)}` : ''}">${esc(label)}</span>`;
export const badge = (b, label) => `<span class="badge k-${cls(b)}">${esc(label ?? b)}</span>`;

// A block the live page compares by hash and swaps only when it changed.
export const hash = (s) => createHash('sha1').update(s).digest('base64url').slice(0, 10);
export const blk = (key, html, tag = 'div', attrs = '') => `<${tag} data-k="${esc(key)}" data-h="${hash(html)}"${attrs}>${html}</${tag}>`;
// A toggle whose open state the live page remembers.
// Stable, unique keys for rows: what the row says, numbered when two say the same.
// The live page matches rows by these keys, so a row keeps its node across updates.
export function keyed(items, keyOf) {
  const seen = new Map();
  return items.map((it) => { const k = keyOf(it); const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return [it, n > 1 ? `${k}~${n}` : k]; });
}
export const toggle = (key, summary, body, cls2 = 'raw') => `<details class="${cls2}" data-d="${esc(key)}" data-a="d-${esc(key)}"><summary>${summary}</summary>${body}</details>`;

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
export const dot = (state, words = DOTS[state] ?? state) => `<span class="dot dot-${cls(state)}" role="img" aria-label="${esc(words)}" title="${esc(words)}"></span>`;
// A unit's dot with its own words: ids it waits on keep their case.
export const unitDot = (u) => dot(u.dot, dotWords(u.dot, u.badge));

// Links to other units of the same run (ctx.unitHref keeps a live page's token).
export const unitLink = (id, ctx) => `<a class="ulink" href="${esc(ctx.unitHref(id))}">${esc(id)}</a>`;
// The state in words ("Waiting for A" with A linked, "Up next", "Retrying"…); the raw status only for a view without one.
export function stateChip(u, ctx) {
  const b = u.badge;
  if (!b) return chip(u.status, u.status);
  const label = esc(b.lead) + b.ids.map((id) => (ctx?.unitHref ? unitLink(id, ctx) : esc(id))).join(', ');
  const kind = ['retrying', 'stale'].includes(b.kind) ? 'flag' : `s-${cls(b.kind)}`;
  return `<span class="chip ${kind}" title="${esc(b.title ?? '')}">${label}</span>`;
}
// Escaped text with the last "waiting for X" / "after X" for each id turned into a link to X.
export function linkWaits(text, ids, ctx) {
  let out = esc(text);
  for (const id of ids) {
    const e = esc(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`((?:waiting for|after) )${e}(?![\\w-])`, 'gi');
    const hits = [...out.matchAll(re)];
    const m = hits.at(-1);
    if (m) out = out.slice(0, m.index) + m[1] + unitLink(id, ctx) + out.slice(m.index + m[0].length);
  }
  return out;
}
// "Blocks: D, E": every unit still waiting on this one (whatever else it waits on), linked.
export function blocksLine(u, ctx) {
  const ids = u.dot === 'passed' ? [] : u.dependents.filter((x) => x.dot && !['passed', 'stopped'].includes(x.dot)).map((x) => x.id);
  return ids.length ? `<p class="cause blocks" data-a="blocks-${esc(u.id)}"><b>Blocks:</b> ${ids.map((id) => unitLink(id, ctx)).join(', ')}</p>` : '';
}

// The header's links between pages (ctx.pages, live only); the current one is marked.
const nav = (ctx, path) => (ctx.pages?.length
  ? `<nav class="pages" aria-label="Pages">${ctx.pages.map((p) => `<a href="${esc(p.href)}"${p.path === path ? ' aria-current="page"' : ''}>${esc(p.label)}</a>`).join('')}</nav>` : '');

// A CSS string from any text: everything but letters, digits and spaces as a hex escape, so nothing can end the string or the rule.
export const cssText = (t) => `"${String(t ?? '').replace(/[^A-Za-z0-9 ]/g, (c) => `\\${c.codePointAt(0).toString(16)} `)}"`;
// Export PDF: the browser's own print to PDF. The live page has a button; the snapshot runs no script, so it says how.
const printTool = (live) => (live ? '<button type="button" class="print-btn" data-print aria-label="Export this page as PDF (opens the print dialog; choose Save as PDF)">Export PDF</button>'
  : '<span class="print-hint" title="Print the page and choose Save as PDF">Export PDF: Ctrl+P or ⌘P, then Save as PDF</span>');
// The printed page's header (the title, on every page) and page numbers: page margin boxes. The export time goes on the first page.
// The live page writes the export time in at print; the snapshot's own time is in its header.
const printHead = () => '<div class="print-head" aria-hidden="true"><span data-printed></span></div>';
const pageRules = (title) => `@page{size:auto;margin:14mm 12mm 16mm;@top-left{content:${cssText(title)};font:9px system-ui,sans-serif;color:#62625c}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px system-ui,sans-serif;color:#62625c}@bottom-left{content:"Coordinator by mindmakr";font:9px system-ui,sans-serif;color:#62625c}}`;

export function page({ title, body, ctx, path, closed = false }) {
  const live = ctx.live;
  const status = closed ? `<span id="live" class="live" role="status" data-state="finished">Finished${live ? '' : ' · snapshot'}</span>`
    : live ? '<span id="live" class="live" role="status" aria-live="polite" data-state="connecting">Connecting…</span><button id="live-retry" class="retry" type="button" hidden>Retry</button>'
      : '<span class="live" data-state="snapshot">Snapshot · read-only</span>';
  const parts = {
    csp: csp(live && { nonce: esc(live.nonce) }), title: esc(`${title} · Coordinator by mindmakr`), favicon: FAVICON, theme: css(ctx.theme ?? { light: LIGHT, dark: DARK }) + pageRules(title),
    top: `${printHead()}<div class="top">${brand()}${nav(ctx, path)}<div class="tools">${status}${printTool(live)}${THEME_TOGGLE}</div></div>`,
    body, footer: footer(),
    attrs: live ? ` data-run="${esc(ctx.store ?? ctx.run)}" data-path="${esc(path)}" data-token="${esc(live.token)}"${closed ? ' data-closed="1"' : ''}` : '',
    script: live ? `<script nonce="${esc(live.nonce)}">${SERVED.map((f) => `const ${f.name} = ${f.toString()};`).join('\n')}\n${CLIENT}</script>` : '',
  };
  return SHELL.replace(/\{\{(\w+)\}\}/g, (_, k) => parts[k] ?? '');
}

export function behaviourList(list, repo, evidence = [], ctx = null, key = '') {
  if (!list.length) return '<p class="empty">No behaviours yet.</p>';
  return `<ul class="behaviours">${list.map((b) => {
    const ev = ctx ? evidence.filter((e) => e.behaviour === b.id) : [];
    return `<li data-a="${esc(`${key || "b"}-${b.id}`)}">${chip(b.status, b.status === 'unchecked' ? '' : b.status)} <b>${esc(b.id)}</b> ${linkify(b.text, repo)}`
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
  // ctx.artHref returning null: the file exists only on the person's machine (the web copy).
  // ctx.has returning false: the stored copy is gone; say so instead of drawing a broken image.
  else if (e.file && ctx.has && !ctx.has(e.file)) body = `<p class="cause">${esc(e.file.split('/').pop())}: missing (the stored copy is gone)</p>`;
  else if (e.file && !ctx.artHref(e.file)) body = `<p class="cause">${esc(e.file.split('/').pop())}: file kept locally</p>`;
  else if (e.file && e.type === 'image') {
    const src = ctx.embed ? ctx.embed(e.file) : ctx.artHref(e.file);
    const full = ctx.artHref(e.file);
    body = src ? `<a href="${esc(full)}" target="_blank" rel="noopener noreferrer"><img class="thumb" src="${esc(src)}" alt="${esc(e.label ?? 'screenshot')}" loading="lazy"></a>`
      : `<p><a href="${esc(full)}" target="_blank" rel="noopener noreferrer">Open the screenshot</a></p>`;
  } else if (e.file) body = `<p><a href="${esc(ctx.artHref(e.file))}" target="_blank" rel="noopener noreferrer">Open ${esc(e.file.split('/').pop())}</a></p>`;
  return `<li class="evidence" data-a="${esc(`${key}-${e.id}`)}"><div>${head} ${stamp(e.at, 'cause')}</div>${body}</li>`;
}

export const evidenceList = (list, repo, ctx, key) => (list.length ? `<ul class="evlist">${list.map((e) => evidenceItem(e, repo, ctx, key)).join('')}</ul>` : '');

export function eventRow(e, repo, key, fin = false) {
  const score = e.score === null || e.score === undefined ? '' : ` · ${e.score}`;
  const cause = e.cause ? ` <span class="cause">cause: ${esc(e.cause)}</span>` : '';
  return `<li${fin ? ' class="fin"' : ''} data-a="${esc(key)}" data-at="${esc(e.at)}" data-badge="${esc(e.badge)}" data-unit="${esc(e.unit ?? '')}">${stamp(e.at)}`
    + `<span>${badge(e.badge, e.label)}</span>`
    + `<span>${e.who ? `<b>${esc(e.who)}${esc(score)}</b> ` : ''}${linkify(e.text, repo)}${cause}</span></li>`;
}

// Search, kind chips, unit chips, range and sort: live page only (they need its script).
export function timelineTools(units = []) {
  const chips = (name, values) => values.map((v) => `<label class="fchip"><input type="checkbox" name="${name}" value="${esc(v)}"><span>${esc(v || 'run')}</span></label>`).join('');
  return '<form class="tl-tools" data-tl role="search">'
    + '<label class="grow">Search <span class="cause" data-tl-matches aria-live="polite"></span><input type="search" name="q" placeholder="Search the timeline"></label>'
    + `<label>When<select name="range">${RANGES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`
    + '<label>Order<select name="sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>'
    + `<fieldset><legend>Kinds</legend>${chips('kind', BADGES)}</fieldset>`
    + (units.length ? `<fieldset><legend>Units</legend>${chips('unit', ['', ...units])}</fieldset>` : '')
    + '<p class="cause" data-tl-count></p></form>';
}
