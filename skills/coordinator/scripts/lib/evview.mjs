// The evidence viewer: a stored screenshot, log or text opens large in an
// overlay with its caption, Previous / Next, Open in new tab and Download.
// The overlay is the element the URL hash names (CSS :target), so the snapshot,
// which runs no script, has it too and a reload reopens it. On the live page
// lib/evview.client.js adds focus, Escape, arrow keys, swipe and the order of
// the list it was opened from (the timeline's filter and sort respected).
// PDFs open in a new tab: the page's CSP allows no frames.
import { extname } from 'node:path';
import { DOC, GOAL_DIR, IMAGE } from './evidence.mjs';
import { esc, linkify } from './links.mjs';

export const TEXT_MAX = 64 * 1024; // a stored text file shown in the snapshot, at most
export const evId = (target, id) => `ev-${target}-${id}`;
const fileName = (file) => String(file).slice(String(file).indexOf('/') + 1); // a stored file is <target>/<name>
const typeOf = (e) => e.type ?? (IMAGE[extname(e.file).toLowerCase()] ? 'image' : DOC[extname(e.file).toLowerCase()] ? 'doc' : 'text');

// What can be shown for one item: 'image', 'text' (a stored text or log file), 'inline' (text in the
// state), 'pdf' (a new tab), 'missing' (the stored copy is gone), or null (a link, or a file kept elsewhere).
export function viewKind(e, ctx) {
  if (typeof e.text === 'string' || e.inline) return 'inline';
  if (!e.file) return null;
  if (ctx.has && !ctx.has(e.file)) return 'missing';
  if (!ctx.artHref(e.file)) return null;
  const t = typeOf(e);
  return t === 'image' ? 'image' : t === 'doc' ? 'pdf' : 'text';
}
export const opens = (k) => k === 'image' || k === 'text' || k === 'inline';

// A link that opens the viewer; `inner` is already escaped HTML.
export const evOpen = (target, id, inner, cls = 'evlink', aria = '') => `<a class="${cls}" href="#${esc(encodeURIComponent(evId(target, id)))}" data-ev-open${aria ? ` aria-label="${esc(aria)}"` : ''}>${inner}</a>`;
const newTab = (href, inner, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
const missing = (file) => `<span class="chip s-fail" title="${esc(`${fileName(file)}: the stored copy is gone`)}">missing</span>`;

// A timeline row's text for an evidence event (e.ev from lib/timeline.mjs); null when it is not one.
export function eventEvidence(e, ctx) {
  const x = e.ev; if (!x || !ctx?.artHref) return null;
  const k = viewKind(x, ctx); const text = esc(e.text);
  if (k === 'missing') return `${text} ${missing(x.file)}`;
  if (k === 'pdf') return `${newTab(ctx.artHref(x.file), text)} <span class="cause">PDF, opens in a new tab</span>`;
  if (!opens(k)) return null;
  const thumb = k === 'image' ? `<img class="evt-thumb" src="${esc(ctx.artHref(x.file))}" alt="" loading="lazy" decoding="async">` : '';
  return evOpen(x.target, x.id, `${thumb}<span>${text}</span>`);
}

// An evidence list item's body for a stored file (lib/parts.mjs); null leaves the old rendering.
export function itemBody(e, target, ctx) {
  const k = viewKind(e, ctx);
  if (k === 'missing') return `<p class="cause">${esc(fileName(e.file))}: missing (the stored copy is gone)</p>`;
  if (k === 'pdf') return `<p>${newTab(ctx.artHref(e.file), `Open ${esc(fileName(e.file))}`)} <span class="cause">in a new tab</span></p>`;
  if (k === 'text') return `<p>${evOpen(target, e.id, `View ${esc(fileName(e.file))}`)}</p>`;
  if (k !== 'image') return null;
  const src = (ctx.embed && ctx.embed(e.file)) || ctx.artHref(e.file);
  return evOpen(target, e.id, `<img class="thumb" src="${esc(src)}" alt="${esc(e.label ?? 'screenshot')}" loading="lazy" decoding="async">`, 'evthumb', `View ${e.id}${e.label ? `: ${e.label}` : ''}`);
}

// The try an item belongs to: verdicts before it, plus one; at most the last try.
const roundOf = (e, rounds) => (rounds?.length ? Math.min(rounds.filter((r) => r.at && e.at && r.at <= e.at).length + 1, rounds.length) : null);

// Every item a page can open, in reading order: the goal's, then each unit's.
export function viewerEntries(v, unitId = null) {
  const units = unitId ? v.units.filter((u) => u.id === unitId) : v.units;
  return [
    ...(unitId ? [] : (v.goalCheck?.evidence ?? []).map((e) => ({ e, target: GOAL_DIR, unit: null, round: null }))),
    ...units.flatMap((u) => u.evidenceItems.map((e) => ({ e, target: u.id, unit: u.id, round: roundOf(e, u.roundList) }))),
  ];
}

function overlay(x, i, all, ctx, repo) {
  const { e, target } = x; const id = evId(target, e.id); const k = x.kind;
  const step = (o, rel, words) => `<a class="evv-btn" data-evv="${rel}"${o ? ` href="#${esc(encodeURIComponent(evId(o.target, o.e.id)))}"` : ' aria-disabled="true"'}>${words}</a>`;
  const href = k === 'inline' ? null : ctx.artHref(e.file);
  const zoom = k === 'image' ? `<label class="evv-btn evv-zl" for="${esc(id)}-z"><span class="evv-fit">Actual size</span><span class="evv-act">Fit to width</span></label>` : '';
  const files = href ? newTab(href, 'Open in new tab', 'evv-btn') + `<a class="evv-btn" href="${esc(href)}" download="${esc(fileName(e.file))}">Download</a>` : '';
  let view;
  if (k === 'image') view = `<label class="evv-img" for="${esc(id)}-z" title="Click to switch between fit to width and actual size"><img src="${esc(href)}" alt="${esc(e.label ?? `${e.id} screenshot`)}" loading="lazy" decoding="async"></label>`;
  else if (k === 'inline') view = `<pre class="evv-pre">${linkify(e.text, repo)}</pre>`;
  else if (ctx.live) view = `<pre class="evv-pre" data-src="${esc(href)}">Loading…</pre>`;
  else {
    const t = ctx.readText ? ctx.readText(e.file) : null;
    view = `<pre class="evv-pre">${t === null ? 'Open the file in a new tab to read it.' : esc(t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}\n… (cut at ${TEXT_MAX / 1024} KB: open the file for the rest)` : t)}</pre>`;
  }
  const cap = [x.unit ? `Unit ${x.unit}` : 'Goal', e.id, e.kind, x.round ? `round ${x.round}` : null].filter(Boolean).map(esc).join(' · ');
  const utc = e.at ? esc(`${e.at.slice(0, 16).replace('T', ' ')} UTC`) : '';
  const when = e.at ? ` · <time datetime="${esc(e.at)}" title="${utc}">${utc}</time>` : '';
  return `<div class="evv" id="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}-t" data-evv-item>`
    + '<a class="evv-shade" href="#_" tabindex="-1" aria-hidden="true"></a><div class="evv-box">'
    + (k === 'image' ? `<input type="checkbox" class="evv-z sr" id="${esc(id)}-z" aria-label="Actual size">` : '')
    + `<div class="evv-bar"><h2 class="evv-t" id="${esc(id)}-t">${esc(e.id)}${e.label ? ` · ${esc(e.label)}` : ''}</h2>`
    + `<div class="evv-tools">${step(all[i - 1], 'prev', '← Previous')}<span class="evv-n">${i + 1} of ${all.length}</span>${step(all[i + 1], 'next', 'Next →')}`
    + `${zoom}${files}<a class="evv-btn evv-x" href="#_" data-evv="close" aria-label="Close the viewer">Close</a></div></div>`
    + `<div class="evv-scroll${k === 'image' ? '' : ' txt'}" tabindex="0" aria-label="${esc(k === 'image' ? 'The image; scroll to see all of it' : 'The text')}">${view}</div>`
    + `<p class="evv-cap">${cap}${when}</p></div></div>`;
}

// Every overlay of a page, or '' when nothing opens.
export function viewer(entries, ctx, repo = null) {
  if (!ctx?.artHref) return '';
  const all = entries.map((x) => ({ ...x, kind: viewKind(x.e, ctx) })).filter((x) => opens(x.kind));
  return all.map((x, i) => overlay(x, i, all, ctx, repo)).join('');
}
