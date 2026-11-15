// The shared components of every page, in the approved canvas markup; their CSS is
// the "Shared components" block of hud.template.html, their colours lib/theme.mjs.
// parts.mjs re-exports them, and page() (parts.mjs) is the shell around them.
//
// Text arguments are escaped. Arguments named *html (and a cell given as { html })
// are HTML the caller built from these helpers or other escaping code.
//
//   heading(title, sub?)              <div class="head">: h1 and a muted line
//   kpis([{ k, v, s?, bar? }])        <div class="kpis">: label, value, small line, optional bar (0-100)
//   cols(mainHtml, sideHtml)          <div class="cols">: main and side columns; the side stacks under main when narrow
//   panel({ id, title, count?, metaHtml?, bodyHtml, open?, scroll?, flush?, tone? })
//                                     details.panel: summary (chevron, h2, count, controls) and its body;
//                                     `id` is data-d, so the live page keeps it open or closed per page
//   table({ cols: [{ label, num? }], rows: [[cell]], min?, max?, empty? })
//                                     table.t with a sticky header, in its own scrolling box
//   toneChip(word, tone?)             span.chip: ask, ok, retry, bad or done; the word is always shown
//   typeTag(kind, file?)              span.tag: IMG, LOG, CSV, TXT, PDF, URL or TEST
//   tries([state])                    try marks: pass ✓, fail ✕, work …, queued (its number), open (empty)
//   bar(pct, { label?, tone? })       div.bar: a meter with its percent as its label
//   restoreOpen(nodes, saved)         the live page's memory of toggles and panels (live.client.js runs it)
import { esc } from './links.mjs';

const text = esc;
const cell = (c) => (c && typeof c === 'object' && 'html' in c ? String(c.html) : text(c));
// A CSS length for max-height or min-width, else nothing.
const length = (v) => (typeof v === 'number' && v > 0 ? `${v}px` : typeof v === 'string' && /^\d+(\.\d+)?(px|rem|em|vh|%)$/.test(v) ? v : '');
const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : 0; };

export const heading = (title, sub = '') => `<div class="head"><h1>${text(title)}</h1>${sub ? `<span class="muted">${text(sub)}</span>` : ''}</div>`;

export function bar(value, { label, tone = '' } = {}) {
  const p = pct(value);
  const t = ['ok', 'bad', 'ask'].includes(tone) ? ` ${tone}` : '';
  return `<div class="bar${t}" role="img" aria-label="${text(label ?? `${p}%`)}"><span style="width:${p}%"></span></div>`;
}

export function kpis(items) {
  return `<div class="kpis">${items.map((i) => `<div class="kpi"><span class="k">${text(i.k)}</span><span class="v">${text(i.v)}</span>`
    + `${i.bar === undefined ? '' : bar(i.bar)}${i.s ? `<span class="s">${text(i.s)}</span>` : ''}</div>`).join('')}</div>`;
}

export const cols = (mainHtml, sideHtml = '') => `<div class="cols"><div class="main">${mainHtml}</div>${sideHtml ? `<div class="side">${sideHtml}</div>` : ''}</div>`;

const TONES = ['ask', 'ok', 'retry', 'bad', 'done'];
export function panel({ id, title, count, metaHtml = '', bodyHtml = '', open = true, scroll, flush = false, tone = '' }) {
  const k = text(id);
  const n = count === undefined || count === null ? '' : `<span class="count">${text(count)}</span>`;
  const h = length(scroll);
  const body = `<div class="body${h ? ' scroll' : ''}${flush ? ' flush' : ''}"${h ? ` style="max-height:${h}"` : ''}>${bodyHtml}</div>`;
  return `<details class="panel${TONES.includes(tone) ? ` ${tone}` : ''}" data-d="${k}" data-a="panel-${k}"${open ? ' open' : ''}>`
    + `<summary><span class="chev" aria-hidden="true">›</span><h2>${text(title)}</h2>${n}${metaHtml ? `<span class="meta">${metaHtml}</span>` : ''}</summary>${body}</details>`;
}

export function table({ cols: heads, rows, min, max, empty = 'None' }) {
  if (!rows.length) return `<p class="empty">${text(empty)}</p>`;
  const num = (i) => (heads[i]?.num ? ' class="num"' : '');
  const w = length(min); const h = length(max);
  return `<div class="scroll tbox"${h ? ` style="max-height:${h}"` : ''}><table class="t"${w ? ` style="min-width:${w}"` : ''}>`
    + `<thead><tr>${heads.map((c, i) => `<th scope="col"${num(i)}>${text(c.label)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${num(i)}>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// A status in words, coloured by tone: the colour never says it alone. No word, no chip.
export function toneChip(word, tone = '') {
  const w = text(word);
  if (!w) return '';
  return `<span class="chip${TONES.includes(tone) ? ` ${tone}` : ''}">${w}</span>`;
}

// What a piece of evidence is, in three or four letters: by its file's extension, else its kind.
const BY_EXT = { png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', svg: 'IMG', log: 'LOG', csv: 'CSV', pdf: 'PDF', txt: 'TXT', md: 'TXT', json: 'TXT' };
const BY_KIND = { screenshot: 'IMG', img: 'IMG', log: 'LOG', csv: 'CSV', txt: 'TXT', text: 'TXT', pdf: 'PDF', link: 'URL', url: 'URL', test: 'TEST', reins: 'TXT', prism: 'TXT' };
export const TYPES = ['IMG', 'LOG', 'CSV', 'TXT', 'PDF', 'URL', 'TEST'];
export function typeOf(kind, file) {
  const ext = typeof file === 'string' ? (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? '').toLowerCase() : '';
  return BY_EXT[ext] ?? BY_KIND[String(kind ?? '').toLowerCase()] ?? 'TXT';
}
export const typeTag = (kind, file) => { const t = typeOf(kind, file); return `<span class="tag" title="${t}">${t}</span>`; };

// Toggles and panels (details[data-d]) as the reader left them: `saved` is { key: open }, kept per
// page by live.client.js. One never touched keeps the state it was rendered in. Returns the map to keep.
export function restoreOpen(nodes, saved) {
  const map = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  for (const d of nodes) { const v = map[d.dataset.d]; if (typeof v === 'boolean' && d.open !== v) d.open = v; }
  return map;
}

// One mark per try, in order. Each says its state in a glyph and in its label.
const TRY = { pass: ['p', '✓', 'passed'], fail: ['f', '✕', 'failed'], work: ['j', '…', 'in progress'], queued: ['q', null, 'queued'], open: ['o', '', 'not used'] };
export function tries(states) {
  const marks = states.map((s, i) => { const [c, g, w] = TRY[s] ?? TRY.open; return { c, g: g ?? String(i + 1), w: `try ${i + 1} ${w}` }; });
  return `<span class="tries" role="img" aria-label="${text(marks.map((m) => m.w).join(', '))}">${marks.map((m) => `<span class="pip ${m.c}" aria-hidden="true">${m.g}</span>`).join('')}</span>`;
}
