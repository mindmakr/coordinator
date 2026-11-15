// A run's maps page (/maps when served, live; maps.html beside hud.html in the
// snapshot, static SVG): the shared shell (lib/ui.mjs), one panel per entry of MAPS,
// each a keyed block the live page patches in place, then the side panels Legend,
// Selected (live only: the walkable maps' selection) and Export. To add a map, add
// an entry: { id, title, open, render(view, ctx, nowMs) }.
import { readFileSync } from 'node:fs';
import { liveCtx, staticCtx } from './hud.mjs';
import { webUrl } from './links.mjs';
import { blk, cols, esc, heading, page, panel, table, toneChip, typeTag, when } from './parts.mjs';
import { behaviourSvg, flowSvg, heatSvg, mindSvg, relevanceSvg } from './mapsvg.mjs';
import { MARKS, unitTips } from './maptips.mjs';
import { navPanel } from './mapnav.mjs';
import { criticalPath } from './maps.mjs';
import { heat } from './heat.mjs';
import { count } from './self.mjs';
import { css, LIGHT } from './theme.mjs';
import { callsView } from './map/callsview.mjs';

export const MAPS = [
  { id: 'mind', title: 'Mind map', open: true, render: mindSvg },
  { id: 'flow', title: 'Flow', open: true, render: flowSvg },
  { id: 'heat', title: 'Activity by hour', open: true, render: heatSvg },
  { id: 'behaviours', title: 'Behaviours', open: false, render: (v, ctx) => behaviourSvg(v, ctx) + behaviourTable(v, ctx) },
  { id: 'relevance', title: 'Goal relevance', open: false, render: relevanceSvg },
  { id: 'calls', title: 'Calls', open: false, render: callsView },
];

// Where a piece of evidence opens: its web link, its stored file, else its unit's page.
const evidenceHref = (e, unit, ctx) => (e.url && webUrl(e.url)) || (e.file && (!ctx.has || ctx.has(e.file)) && ctx.artHref(e.file)) || ctx.unitHref(unit);
const evidenceLink = (e, unit, ctx) => {
  const ext = !!(e.url && webUrl(e.url));
  return `<a class="evtag" href="${esc(evidenceHref(e, unit, ctx))}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''} title="${esc(e.label ?? e.kind ?? '')}">${typeTag(e.kind, e.file)}</a>`;
};
const STATUS = { pass: ['Pass', 'ok'], fail: ['Fail', 'bad'], unchecked: ['Unchecked', ''] };
const statusChip = (s) => toneChip(...(STATUS[s] ?? [s, '']));

// Every behaviour as a row: its unit, its words, its status in a word, its evidence by type. Each links to its item.
function behaviourTable(v, ctx) {
  const unitA = (id) => `<a class="mono" href="${esc(ctx.unitHref(id))}">${esc(id)}</a>`;
  const goal = v.goalCheck.behaviours.map((b) => [{ html: `<a href="${esc(ctx.home)}">Goal</a>` }, { html: `<a href="${esc(ctx.home)}"><b>${esc(b.id)}</b> ${esc(b.text)}</a>` }, { html: statusChip(b.status) }, '']);
  const units = v.units.flatMap((u) => u.behaviours.map((b) => [
    { html: unitA(u.id) },
    { html: `<a href="${esc(ctx.unitHref(u.id))}"><b>${esc(b.id)}</b> ${esc(b.text)}</a>` },
    { html: statusChip(b.status) },
    { html: (u.evidenceItems ?? []).filter((e) => e.behaviour === b.id).map((e) => evidenceLink(e, u.id, ctx)).join(' ') },
  ]));
  const rows = [...goal, ...units];
  return rows.length ? table({ cols: [{ label: 'Unit' }, { label: 'Behaviour' }, { label: 'Status' }, { label: 'Evidence' }], rows, min: 520, max: 360 }) : '';
}

// Unit states in words, toned as the dashboard tones them; status marks; evidence types.
const STATES = [['Passed', 'ok'], ['Needs you', 'ask'], ['Working', ''], ['Retrying', 'retry'], ['Quiet', 'bad'], ['Waiting', ''], ['Up next', ''], ['Stopped', '']];
const TYPE_WORDS = [['IMG', 'image'], ['LOG', 'log'], ['CSV', 'table'], ['TXT', 'text'], ['PDF', 'document'], ['URL', 'link'], ['TEST', 'test output']];
const legend = () => `<div class="maps-legend"><div class="chips">${STATES.map(([w, t]) => toneChip(w, t)).join('')}</div>`
  + `<ul class="marks">${Object.entries(MARKS).map(([s, m]) => `<li><b aria-hidden="true">${m}</b> ${esc(s)}</li>`).join('')}</ul>`
  + `<ul class="types">${TYPE_WORDS.map(([k, w]) => `<li><span class="tag">${k}</span> ${w}</li>`).join('')}</ul></div>`;

// ---- Export: files the reader saves with one click, built here so they work without a script.
// A map's SVG carries its own light-theme styles: the tokens (lib/theme.mjs) and the map rules of hud.template.html.
const TEMPLATE = readFileSync(new URL('./hud.template.html', import.meta.url), 'utf8');
const SVG_RULES = TEMPLATE.split('\n').filter((l) => /^(svg\.map |\.st-|:root \{ --card)/.test(l)).join('\n');
const SVG_CSS = `${css({ light: LIGHT, dark: LIGHT })}\n${SVG_RULES}\nsvg.map{background:var(--surface)}`;
export function svgFile(html) {
  const m = /<svg class="map[\s\S]*?<\/svg>/.exec(html);
  return m ? m[0].replace(/^(<svg[^>]*>)/, `$1<style>${SVG_CSS.replace(/</g, '\\3c ')}</style>`) : null;
}
// A spreadsheet cell: quoted, and never read as a formula.
const cell = (x) => { const s = String(x ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
export const csvText = (rows) => `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
export function heatCsv(v, nowMs) {
  const h = heat(v, nowMs);
  return csvText([['unit', 'from (UTC)', 'tries', 'failed', 'heartbeats', 'other events', 'waited (min)'],
    ...h.rows.flatMap((r) => r.cells.map((c, i) => [r.unit, h.cols[i].at.slice(0, 16).replace('T', ' '), c.rounds, c.fails, c.beats, c.other, c.waitMin]))]);
}
export function behavioursCsv(v) {
  const ev = (u, b) => (u.evidenceItems ?? []).filter((e) => e.behaviour === b.id).length;
  return csvText([['unit', 'behaviour', 'status', 'text', 'evidence'],
    ...v.goalCheck.behaviours.map((b) => ['goal', b.id, b.status, b.text, '']),
    ...v.units.flatMap((u) => u.behaviours.map((b) => [u.id, b.id, b.status, b.text, ev(u, b)]))]);
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const download = (label, name, type, data) => (data ? `<a download="${esc(name)}" href="data:${type};base64,${b64(data)}">${esc(label)}</a>` : '');
const safeName = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

export function mapsPage(v, nowMs = Date.now(), ctx = null) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const drawn = new Map(MAPS.map((m) => [m.id, m.render(v, ctx, nowMs)]));
  const nB = v.units.reduce((n, u) => n + u.behaviours.length, 0) + v.goalCheck.behaviours.length; // the goal's own behaviours are rows of the table too
  const nE = v.units.reduce((n, u) => n + (u.evidenceItems ?? []).length, 0);
  const crit = criticalPath(v.units, nowMs).path;
  const meta = { flow: crit.length ? `${toneChip('Critical path')}<span class="mono">${esc(crit.join(' → '))}</span>` : '' };
  const counts = { behaviours: nB, relevance: v.units.length };
  const main = MAPS.map((m) => panel({ id: m.id, title: m.title, count: counts[m.id], metaHtml: meta[m.id], open: m.open,
    bodyHtml: blk(`map-${m.id}`, drawn.get(m.id), 'section', ` class="maps" id="map-${m.id}" aria-label="${esc(m.title)}"`) })).join('');
  const f = safeName(v.id);
  const files = [download('Mind map SVG', `${f}-mind-map.svg`, 'image/svg+xml', svgFile(drawn.get('mind'))), download('Flow SVG', `${f}-flow.svg`, 'image/svg+xml', svgFile(drawn.get('flow'))),
    download('Activity CSV', `${f}-activity.csv`, 'text/csv', v.units.length ? heatCsv(v, nowMs) : null), download('Behaviours CSV', `${f}-behaviours.csv`, 'text/csv', nB ? behavioursCsv(v) : null)].join('');
  const side = [
    panel({ id: 'legend', title: 'Legend', bodyHtml: legend() }),
    // The walkable maps' selection (lib/mapnav.client.js fills it); selecting needs the live script.
    ctx.live ? panel({ id: 'selected', title: 'Selected', bodyHtml: `${navPanel()}<p class="empty" data-nav-none>None</p>` }) : '',
    panel({ id: 'export', title: 'Export', open: false, bodyHtml: blk('map-export', files ? `<div class="exports">${files}</div>` : '<p class="empty">None</p>') }),
  ].join('');
  const body = [
    blk('head', heading('Maps', `${count(v.units.length, 'unit')} · ${count(nB, 'behaviour')} · ${count(nE, 'evidence item')} · ${v.phase} · updated ${when(new Date(nowMs).toISOString())}`)),
    `<div class="maps-page">${cols(main, side)}</div>`,
    // One stats panel per unit, shared by every map's box for that unit (lib/maptips.mjs).
    blk('map-tips', unitTips(v, ctx, nowMs)),
  ].join('\n');
  return page({ title: `Maps · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/maps`, closed: !v.open, crumbs: [{ label: v.id, href: ctx.home }, { label: 'Maps' }] });
}
