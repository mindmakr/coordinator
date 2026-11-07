// Labels and stats panels for the maps. Every unit box carries a status mark
// (never colour alone) and its id; hovering, focusing or tapping it shows a
// panel of its stats and lights what it connects to while the rest dims.
// CSS does the showing (:has), so the static snapshot needs no script; the
// live page's script (maptips.client.js) adds tap to pin, Escape, and places
// the panel beside its box. State text is escaped; only http(s) links.
import { esc, webUrl } from './links.mjs';
import { clip, DOTS, duration } from './plain.mjs';
import { count } from './self.mjs';
import { spent, unitRefs } from './maps.mjs';

// One mark per unit status (lib/schema.mjs).
export const MARKS = { pass: '✓', fail: '✗', stopped: '■', open: '○', building: '▶', judging: '◆' };
export const mark = (status) => MARKS[status] ?? '•';
export const marksLegend = () => `<p class="map-legend" aria-label="Status marks">${Object.entries(MARKS).map(([s, m]) => `<span><b aria-hidden="true">${m}</b>${s}</span>`).join('')}<span class="cause">Hover, focus or tap a unit for its stats; Tab from a unit enters its panel; Escape closes.</span></p>`;

export const tipId = (i) => `tip-u${i}`;
export const unitIndex = (v) => new Map(v.units.map((u, i) => [u.id, i]));
// Attributes for a unit's box: u (has a panel), u<i>, hl (dims while another box is lit).
// nb: the unit indexes this box connects to; their boxes light it, so it carries their c<j>.
export const boxAttrs = (i, nb = []) => ` class="u u${i} hl${nb.filter((j) => j !== i && j !== undefined).map((j) => ` c${j}`).join('')}" aria-describedby="${tipId(i)}"`;

// Units connected to each unit, by index: waits on or waited on by (--after, both ways) and sharing a linked issue or PR.
export function neighbours(v) {
  const ix = unitIndex(v); const nb = new Map(v.units.map((_, i) => [i, new Set()]));
  const tie = (a, b) => { if (a !== undefined && b !== undefined && a !== b) { nb.get(a).add(b); nb.get(b).add(a); } };
  const byRef = new Map();
  for (const u of v.units) {
    tie(ix.get(u.id), ix.get(u.after));
    for (const r of unitRefs(u)) { if (!byRef.has(r.key)) byRef.set(r.key, []); byRef.get(r.key).push(ix.get(u.id)); }
  }
  for (const list of byRef.values()) for (const a of list) for (const b of list) tie(a, b);
  return new Map([...nb].map(([i, set]) => [i, [...set].sort((a, b) => a - b)]));
}
// Classes for what a box connects to: c<i> for nodes, e<i> for edges, per unit index.
export const near = (is, p = 'c') => ['hl', ...is.filter((i) => i !== undefined).map((i) => `${p}${i}`)].join(' ');

const row = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : '');
// The state in the dashboard's words (Waiting for A, Up next, Retrying…); an older view falls back to the status.
const state = (u) => u.badge?.label ?? `${u.status}${DOTS[u.dot] && !['passed', 'stopped'].includes(u.dot) ? ` · ${DOTS[u.dot]}` : ''}`;

export function unitTip(u, i, ctx, nowMs) {
  const trail = (u.scores ?? []).map((s) => (s.score === null ? '–' : String(s.score))).join(' → ');
  const refs = unitRefs(u).map((r) => ({ ...r, url: webUrl(r.url) })).filter((r) => r.url)
    .map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(`${r.kind === 'pr' ? 'PR' : 'Issue'} ${r.repo}#${r.n}`)}</a>`).join(', ');
  const minutes = spent(u, nowMs);
  const gap = u.gap ? `${esc(clip(u.gap, 220))}${u.cause ? ` <span class="cause">cause: ${esc(clip(u.cause, 80))}</span>` : ''}` : u.cause ? `cause: ${esc(clip(u.cause, 80))}` : '';
  return `<div class="tip" id="${tipId(i)}" role="dialog" aria-modal="false" aria-labelledby="${tipId(i)}-h" data-u="${i}">`
    + `<p class="tip-h" id="${tipId(i)}-h"><b class="tip-mark st-${esc(String(u.dot ?? '').replace(/[^a-z-]/g, ''))}" aria-hidden="true">${mark(u.status)}</b> <b>${esc(u.id)}</b> <span class="cause">${esc(state(u))}</span></p>`
    + (u.title ? `<p class="tip-t">${esc(clip(u.title, 200))}</p>` : '')
    + '<dl>'
    + row('Round', esc(`${u.rounds ?? 0}/${u.maxRounds ?? '?'}`))
    + row('Scores', esc(trail || 'none yet'))
    + row('Time', esc(minutes ? duration(minutes) : 'not started'))
    + row('Last gap', gap)
    + row('Linked', refs)
    + row('Other runs', u.chainText ? esc(clip(u.chainText, 220)) : '')
    + row('Files', esc(typeof u.files === 'number' ? count(u.files, 'file') + ' touched' : 'not checked yet'))
    + `</dl><a class="tip-open" href="${esc(ctx.unitHref(u.id))}">Open ${esc(u.id)} →</a></div>`;
}

// The panel shows at once and hides a moment after the pointer leaves its box, so the pointer can reach it.
export const SHOW = 'visibility:visible;transition-delay:0s';

// One panel per unit for the whole page, and the rules that show each one and light its links.
export function unitTips(v, ctx, nowMs) {
  if (!v.units.length) return '';
  const rules = v.units.map((_, i) => `body:not([data-tips=off]):has(.u${i}:is(:hover,:focus)) #${tipId(i)}{${SHOW}}`
    + `svg.map:not([data-nav]):has(.u${i}:is(:hover,:focus)) :is(.u${i},.c${i},.e${i}),svg.map[data-nav]:has(.u${i}:is(:hover,:focus-visible)) .u${i},body:has(#${tipId(i)}:focus-within) svg.map :is(.u${i},.c${i},.e${i}){opacity:1}`).join('');
  return `<div class="tips">${v.units.map((u, i) => unitTip(u, i, ctx, nowMs)).join('')}</div><style>${rules}</style>`;
}
