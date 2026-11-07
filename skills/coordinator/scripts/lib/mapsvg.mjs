// The maps drawn as inline SVG (lib/maps.mjs and lib/heat.mjs build the data).
// No script, no network: colours are classes the page's theme styles, so light,
// dark and a project theme all apply. Every node is a link (a unit's page, the
// dashboard, or a GitHub issue or PR in a new tab with no referrer), focusable,
// with its words in a <title> and an aria-label. State text is always escaped;
// only http(s) URLs become external links.
import { webUrl } from './links.mjs';
import { esc } from './parts.mjs';
import { clip, DOTS, duration } from './plain.mjs';
import { count } from './self.mjs';
import { behaviourGrid, heat } from './heat.mjs';
import { flowGraph, mindGraph, relevance } from './maps.mjs';
import { boxAttrs, mark, marksLegend, near, neighbours, tipId, unitIndex } from './maptips.mjs';
import { navGraph, navHelp, navTools } from './mapnav.mjs';

const r1 = (n) => Math.round(n * 10) / 10;
const st = (s) => `st-${String(s ?? '').toLowerCase().replace(/[^a-z-]/g, '')}`;
const STATUS = { ...DOTS, met: 'met', 'not-yet': 'not met yet', pass: 'pass', fail: 'fail', unchecked: 'unchecked', evidence: 'evidence' };
const said = (s) => STATUS[s] ?? s;

// A focusable link around a shape. Internal hrefs come from ctx (already encoded); external ones must be http(s).
// attrs: trusted markup from lib/maptips.mjs (classes, aria-describedby), or a class list (cls).
export function link(href, label, inner, external = false, attrs = '') {
  const url = external ? webUrl(href) : href;
  if (!url) return `<g role="img" aria-label="${esc(label)}"${attrs}><title>${esc(label)}</title>${inner}</g>`;
  return `<a href="${esc(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''} aria-label="${esc(label)}"${attrs}><title>${esc(label)}</title>${inner}</a>`;
}
const cls = (c) => (c ? ` class="${c}"` : '');
// Drawn at its own size, never shrunk, so labels stay readable (13 px ids, 10.5 px at the smallest);
// a map wider than its box scrolls inside it, with a hint (on a phone above PHONE px, everywhere above WIDE px).
const PHONE = 356; const WIDE = 1086;
const svg = (w, h, label, body, cls = '', attrs = '') => { const W = Math.ceil(w); const H = Math.ceil(h);
  const hint = W > PHONE ? `<p class="map-hint${W > WIDE ? ' wide' : ''}" aria-hidden="true">↔ Scroll inside the map to see all of it.</p>` : '';
  return `${hint}<div class="map-scroll${cls}" tabindex="0" role="region" aria-label="${esc(label)}"><svg class="map${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(label)}"${attrs} xmlns="http://www.w3.org/2000/svg">${body}</svg></div>`; };
const txt = (x, y, s, cls = '', anchor = '') => `<text x="${r1(x)}" y="${r1(y)}"${cls ? ` class="${cls}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
const empty = (t) => `<p class="empty">${esc(t)}</p>`;
const legend = (items) => `<p class="map-legend">${items.map(([c, l]) => `<span><i class="sw ${c}" aria-hidden="true"></i>${esc(l)}</span>`).join('')}</p>`;

// Goal at the centre; units on the first ring (labelled boxes), their behaviours on the second, evidence outside.
const PW = 140; const PH = 42; const PG = 12;
// The smallest ring on which neighbouring unit boxes clear each other (side by side or one above the other).
export function ringRadius(n, base) {
  let r = base;
  for (let i = 0; n > 1 && i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; const b = a + (2 * Math.PI) / n;
    const dx = Math.abs(Math.cos(b) - Math.cos(a)); const dy = Math.abs(Math.sin(b) - Math.sin(a));
    r = Math.max(r, Math.min(dx > 1e-9 ? (PW + PG) / dx : Infinity, dy > 1e-9 ? (PH + PG) / dy : Infinity));
  }
  return r;
}

export function mindSvg(v, ctx) {
  const g = mindGraph(v);
  const units = g.nodes.filter((n) => n.kind === 'unit');
  if (!units.length) return empty('No units yet.');
  const ix = unitIndex(v); const nb = neighbours(v);
  const byId = new Map(v.units.map((u) => [u.id, u]));
  const kids = (id) => g.nodes.filter((n) => n.parent === id);
  const hasB = g.nodes.some((n) => n.kind !== 'goal' && n.kind !== 'unit');
  const R1 = Math.ceil(ringRadius(units.length, hasB ? 150 : 190)); const R2 = R1 + 115; const R3 = R2 + 60;
  // Drawn twice: once to measure, once placed so the picture fills its box (one unit needs no full circle).
  const draw = (cx, cy) => {
    const at = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const sector = Math.min((2 * Math.PI) / units.length, Math.PI * 0.9) * 0.82;
    const spread = (k, m, mid, width) => (m < 2 ? mid : mid - width / 2 + (k * width) / (m - 1));
    const labels = g.nodes.filter((n) => n.kind === 'behaviour').length <= 48;
    const edges = []; const nodes = []; const pts = [];
    const line = (x1, y1, x2, y2, i) => edges.push(`<line class="edge ${near([i], 'e')}" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`);
    const leaf = (n, x, y, a) => {
      pts.push([x, y, n.kind === 'behaviour' && labels ? 34 : 12]);
      const unitHref = ctx.unitHref(n.unit);
      const c = cls(near([ix.get(n.unit)]));
      if (n.kind === 'behaviour') {
        nodes.push(link(unitHref, `${n.unit} ${n.label}: ${said(n.status)} — ${clip(n.text, 160)}`, `<circle class="nd ${st(n.status)}" cx="${r1(x)}" cy="${r1(y)}" r="9"/>`
          + (labels ? txt(cx + (R2 + 16) * Math.cos(a), cy + (R2 + 16) * Math.sin(a) + 4, n.label, 'sm', Math.cos(a) < -0.2 ? 'end' : Math.cos(a) > 0.2 ? 'start' : 'middle') : ''), false, c));
      } else {
        const href = n.url ? n.url : (n.file && ctx.artHref(n.file)) || unitHref; // a file kept locally opens its unit
        const shape = n.kind === 'more' ? `<circle class="nd ev" cx="${r1(x)}" cy="${r1(y)}" r="9"/>${txt(x, y + 3, n.label, 'xs', 'middle')}` : `<circle class="nd ev" cx="${r1(x)}" cy="${r1(y)}" r="4.5"/>`;
        nodes.push(link(href, `${n.unit} evidence (${n.label}): ${clip(n.text, 160)}`, shape, !!n.url, c));
      }
    };
    units.forEach((u, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / units.length;
      const [x, y] = at(R1, a); pts.push([x, y, PW / 2 + 2]);
      const ui = ix.get(u.unit);
      line(cx, cy, x, y, ui);
      const ks = kids(u.id);
      ks.forEach((k, j) => {
        const ka = spread(j, ks.length, a, sector); const [kx, ky] = at(R2, ka);
        line(x, y, kx, ky, ui);
        leaf(k, kx, ky, ka);
        const es = kids(k.id);
        es.forEach((e, m) => {
          const ea = spread(m, es.length, ka, (sector / Math.max(1, ks.length)) * 0.8); const [ex, ey] = at(R3, ea);
          line(kx, ky, ex, ey, ui);
          leaf(e, ex, ey, ea);
        });
      });
      const status = byId.get(u.unit)?.status;
      const x0 = x - PW / 2; const y0 = y - PH / 2;
      nodes.push(link(ctx.unitHref(u.unit), `${u.unit}: ${status ?? said(u.status)}, ${said(u.status)}${u.text ? ` — ${clip(u.text, 160)}` : ''}`,
        `<rect class="nd ${st(u.status)}" x="${r1(x0)}" y="${r1(y0)}" width="${PW}" height="${PH}" rx="10"/>${txt(x0 + 10, y0 + 18, `${mark(status)} ${clip(u.label, 14)}`, 'b')}${txt(x0 + 10, y0 + 33, clip(u.text, 22), 'xs muted')}`, false, boxAttrs(ui, nb.get(ui))));
    });
    const goal = g.nodes[0]; const gb = v.goalCheck.behaviours;
    const goalNode = link(ctx.home, `Goal: ${said(goal.status)} — ${clip(goal.text, 200)}`, `<circle class="nd goal ${st(goal.status)}" cx="${r1(cx)}" cy="${r1(cy)}" r="58"/>${txt(cx, cy - 8, 'Goal', 'b', 'middle')}`
      + txt(cx, cy + 10, goal.status === 'met' ? 'met' : 'not yet', 'sm', 'middle') + (gb.length ? txt(cx, cy + 26, `${gb.filter((b) => b.status === 'pass').length}/${gb.length} pass`, 'xs', 'middle') : ''));
    pts.push([cx, cy, 60]);
    return { body: `<g aria-hidden="true">${edges.join('')}</g>${nodes.join('')}${goalNode}`, pts };
  };
  const box = (pts) => [Math.min(...pts.map(([x, , r]) => x - r)), Math.min(...pts.map(([, y, r]) => y - r)), Math.max(...pts.map(([x, , r]) => x + r)), Math.max(...pts.map(([, y, r]) => y + r))];
  const [x0, y0, x1, y1] = box(draw(0, 0).pts);
  const M = 12; const { body } = draw(M - x0, M - y0);
  return svg(x1 - x0 + 2 * M, y1 - y0 + 2 * M, 'Mind map: the goal, its units, their behaviours and evidence', body, ' mind')
    + legend([['st-working', 'working'], ['st-waiting', 'waiting or retrying'], ['st-stale', 'quiet'], ['st-passed', 'passed'], ['st-stopped', 'stopped'], ['st-pass', 'behaviour pass'], ['st-fail', 'behaviour fail'], ['st-unchecked', 'unchecked'], ['ev', 'evidence']])
    + marksLegend();
}

const UW = 172; const UH = 46; const RW = 176; const RH = 44; const FW = 240; const FH = 40; const GX = 64; const GY = 14; const P = 16; const TOP = 34;

// Places nodes in a column near a target y each, top to bottom, never overlapping. No target (Infinity): at the end.
function stack(list, h, gap) {
  let y = TOP;
  return [...list].sort((a, b) => a.want - b.want).map((n) => { const at = Number.isFinite(n.want) ? Math.max(y, n.want) : y; y = at + h + gap; return { ...n, y: at }; });
}
// Lines leave a box already apart (the control points follow the slope), so lines from one box can each be hovered.
const bez = (x1, y1, x2, y2) => { const dx = Math.max(24, (x2 - x1) / 2); const k = (y2 - y1) * 0.25; return `M${r1(x1)} ${r1(y1)} C${r1(x1 + dx)} ${r1(y1 + k)} ${r1(x2 - dx)} ${r1(y2 - k)} ${r1(x2)} ${r1(y2)}`; };
// A line on a walkable map, drawn; its pointer target comes from mapnav's hitLayers(), under every box.
const line2 = (d, cls, end = '', at = 'end') => `<path class="edge ${cls}"${end ? ` marker-${at}="url(#${end})"` : ''} d="${d}"/>`;
// Lines leaving (or reaching) one box spread along its side, in the order of where they go, so no two share an end.
// box(key) → { y, h }. Returns m → [start y, end y].
export function ports(list, box) {
  const at = new Map();
  const mid = (k) => { const b = box(k); return b.y + b.h / 2; };
  const side = (key, which, other) => {
    const mine = list.map((e, m) => [e, m]).filter(([e]) => e[which] === key).sort(([a], [b]) => mid(a[other]) - mid(b[other]));
    const n = mine.length; const step = n > 1 ? Math.min(10, (box(key).h - 12) / (n - 1)) : 0;
    mine.forEach(([, m], j) => at.set(`${which}${m}`, mid(key) + (j - (n - 1) / 2) * step));
  };
  for (const key of new Set(list.flatMap((e) => [e.from, e.to]))) { side(key, 'from', 'to'); side(key, 'to', 'from'); }
  return (m) => [at.get(`from${m}`), at.get(`to${m}`)];
}

// The flow map's line ends, one per kind, so no two relations look alike.
// waits on: a filled arrowhead at the unit waited for; critical path: the same in the run colour;
// links an issue or PR: a ring at the issue end; filed a follow-up: an open arrowhead at the follow-up.
const ENDS = {
  'flow-arrow-after': ['<path class="arrow" d="M0 0 10 5 0 10z"/>', 9, 7],
  'flow-arrow-crit': ['<path class="arrow crit" d="M0 0 10 5 0 10z"/>', 9, 7],
  'flow-arrow-link': ['<circle class="arrow link" cx="5" cy="5" r="3.6"/>', 5, 7],
  'flow-arrow-fu': ['<path class="arrow fu" d="M1 1 9 5 1 9"/>', 9, 9],
};
const SWATCH = {
  after: '<path class="edge after" d="M10 6H34"/><path class="arrow" d="M1 6 10 1.5V10.5z"/>',
  crit: '<path class="edge crit" d="M10 6H34"/><path class="arrow crit" d="M1 6 10 1.5V10.5z"/>',
  link: '<path class="edge link" d="M0 6H28"/><circle class="arrow link" cx="30" cy="6" r="3.4"/>',
  fu: '<path class="edge follow-up" d="M0 6H32"/><path class="arrow fu" d="M27 1.5 34 6 27 10.5"/>',
  named: '<path class="edge named" d="M0 6H34"/>',
  inferred: '<path class="edge inferred" d="M0 6H34"/>',
};
const lineKey = (items) => `<p class="map-legend lines" aria-label="What the lines mean">${items.map(([k, l]) => `<span><svg class="lsw" width="36" height="12" viewBox="0 0 36 12" aria-hidden="true">${SWATCH[k]}</svg>${esc(l)}</span>`).join('')}</p>`;
const counts = (parts) => `<p class="map-legend counts">${parts.filter(([n]) => n !== null).map(([n, l]) => `<span><b>${esc(n)}</b> ${esc(l)}</span>`).join('')}</p>`;

export function flowSvg(v, ctx, nowMs = Date.now()) {
  const g = flowGraph(v, nowMs);
  const units = g.nodes.filter((n) => n.kind === 'unit');
  if (!units.length) return empty('No units yet.');
  const ix = unitIndex(v); const byId = new Map(v.units.map((u) => [u.id, u]));
  const nav = navGraph(g.nodes.map((n) => n.id), g.edges);
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  const pos = new Map();
  const D = Math.max(...units.map((u) => u.depth));
  for (let d = 0; d <= D; d++) {
    const layer = units.filter((u) => u.depth === d).map((u, i) => {
      const up = g.edges.find((e) => e.kind === 'after' && e.to === u.id);
      return { ...u, want: up ? pos.get(up.from).y : TOP + i * (UH + GY) };
    });
    for (const n of stack(layer, UH, GY)) pos.set(n.id, { x: P + d * (UW + GX), y: n.y, w: UW, h: UH, n });
  }
  const mid = (ids) => ids.reduce((s, id) => s + pos.get(`u:${id}`).y + UH / 2, 0) / Math.max(1, ids.length);
  let x = P + (D + 1) * (UW + GX);
  const refs = g.nodes.filter((n) => n.kind === 'issue' || n.kind === 'pr').map((n) => ({ ...n, want: mid(n.units) - RH / 2 }));
  const refX = x; if (refs.length) x += RW + GX;
  for (const n of stack(refs, RH, 8)) pos.set(n.id, { x: refX, y: n.y, w: RW, h: RH, n });
  const fus = g.nodes.filter((n) => n.kind === 'follow-up').map((n) => ({ ...n, want: n.units.length ? mid(n.units) - FH / 2 : Infinity }));
  const fuX = x; if (fus.length) x += FW + GX;
  for (const n of stack(fus, FH, 8)) pos.set(n.id, { x: fuX, y: n.y, w: FW, h: FH, n });
  const width = x - GX + P; const height = Math.max(...[...pos.values()].map((p) => p.y + p.h)) + P;
  const what = (n) => (n.kind === 'pr' ? 'PR' : 'Issue');
  const name = (n) => (n.kind === 'unit' ? n.unit : n.kind === 'follow-up' ? n.label : `${what(n)} ${n.label}`);
  const said2 = (e) => { const a = node.get(e.from); const b = node.get(e.to);
    return e.kind === 'after' ? `${name(b)} waits on ${name(a)}${e.crit ? ' (critical path)' : ''}` : e.kind === 'link' ? `${name(a)} links ${name(b)}` : `${name(a)} filed ${name(b)}`; };
  // A stacked unit waits on the one before it: that line's arrowhead points back to it, and the line says so.
  const port = ports(g.edges, (k) => pos.get(k));
  const edge = (e, m) => {
    const a = pos.get(e.from); const b = pos.get(e.to);
    const x1 = a.x + a.w; const x2 = b.x; const [y1, y2] = port(m);
    const end = e.crit ? 'flow-arrow-crit' : e.kind === 'after' ? 'flow-arrow-after' : e.kind === 'link' ? 'flow-arrow-link' : 'flow-arrow-fu';
    const d = bez(x1, y1, x2, y2);
    const path = line2(d, `${e.kind}${e.crit ? ' crit' : ''}`, end, e.kind === 'after' ? 'start' : 'end');
    const words = e.kind === 'after' ? `<text class="xs muted elabel" x="${r1((x1 + x2) / 2)}" y="${r1((y1 + y2) / 2 - 6)}" text-anchor="middle">waits on</text>` : '';
    return nav.edge(m, e, said2(e), d, path + words);
  };
  // A follow-up line crosses the issue column: its drawn copy goes above those boxes, but takes no pointer.
  const copy = (e, m) => { const a = pos.get(e.from); const b = pos.get(e.to); const [y1, y2] = port(m);
    return `<path class="edge follow-up copy hl ed${m} ${nav.cls(m)}" aria-hidden="true" data-from="${esc(e.from)}" data-to="${esc(e.to)}" marker-end="url(#flow-arrow-fu)" d="${bez(a.x + a.w, y1, b.x, y2)}"/>`; };
  // Follow-up lines cross the issue column, so they go above its nodes.
  const all = g.edges.map((e, m) => [e, m]);
  const edges = all.map(([e, m]) => edge(e, m)).join('');
  const late = all.filter(([e]) => e.kind === 'follow-up').map(([e, m]) => copy(e, m)).join('');
  const heads = [txt(P, 20, D ? 'Units, stacked left to right' : 'Units', 'h'), refs.length ? txt(refX, 20, 'Issues and PRs', 'h') : '', fus.length ? txt(fuX, 20, 'Follow-ups', 'h') : ''].join('');
  const data = (n, kind) => ` data-name="${esc(name(n))}" data-kind="${kind}"`;
  const nodeOf = ({ x: nx, y, w, h, n }) => {
    if (n.kind === 'unit') {
      const status = byId.get(n.unit)?.status; const i = ix.get(n.unit);
      const label = `${n.unit}: ${status ? `${status}, ` : ''}${said(n.status)}${n.crit ? ', on the critical path' : ''}${n.title ? ` — ${clip(n.title, 120)}` : ''}`;
      return link(ctx.unitHref(n.unit), label, `<rect class="nd ${st(n.status)}${n.crit ? ' crit' : ''}" x="${nx}" y="${y}" width="${w}" height="${h}" rx="8"/>${txt(nx + 10, y + 19, `${mark(status)} ${clip(n.label, 18)}`, 'b')}${txt(nx + 10, y + 36, clip(n.title, 24), 'sm muted')}`, false, nav.node(n.id, `u u${i} hl`, ` aria-describedby="${tipId(i)}"${data(n, 'unit')}`));
    }
    if (n.kind === 'follow-up') return link(n.url ?? ctx.home, `Follow-up${n.units.length ? ` from ${n.units.join(', ')}` : ''}: ${clip(n.text, 200)}`, `<rect class="nd fu" x="${nx}" y="${y}" width="${w}" height="${h}" rx="6"/>${txt(nx + 10, y + 16, clip(`${n.label}${n.units.length ? ` · from ${n.units.join(', ')}` : ''}`, 42), 'xs muted')}${txt(nx + 10, y + 32, clip(n.text, 36), 'sm')}`, !!n.url, nav.node(n.id, 'hl', data(n, 'follow-up')));
    return link(n.url, `${what(n)} ${n.repo}#${n.label.split('#')[1]}${n.cross ? ' (another repo)' : ''}, linked by ${n.units.join(', ')}`, `<rect class="nd ref${n.cross ? ' cross' : ''}" x="${nx}" y="${y}" width="${w}" height="${h}" rx="16"/>${txt(nx + 12, y + 18, clip(`${what(n)} ${n.label}`, 26), 'sm')}${txt(nx + 12, y + 34, clip(`linked by ${n.units.join(', ')}`, 30), 'xs muted')}`, true, nav.node(n.id, 'hl', data(n, n.kind)));
  };
  const placed = [...pos.values()];
  const nodes = placed.filter((p) => p.n.kind !== 'follow-up').map(nodeOf).join('') + `<g class="edges" aria-hidden="true">${late}</g>` + placed.filter((p) => p.n.kind === 'follow-up').map(nodeOf).join('');
  const defs = `<defs>${Object.entries(ENDS).map(([id, [shape, ref, size]]) => `<marker id="${id}" viewBox="0 0 10 10" refX="${ref}" refY="5" markerWidth="${size}" markerHeight="${size}" orient="auto-start-reverse">${shape}</marker>`).join('')}</defs>`;
  const c = g.critical;
  const say = !c.stacked ? '<p class="map-say cause">No stacked work: the units run side by side, so there is no critical path.</p>' : c.path.length
    ? `<p class="map-say"><b>Critical path:</b> ${c.path.map((id) => `<a href="${esc(ctx.unitHref(id))}">${esc(id)}</a>`).join(' → ')} <span class="cause">· about ${esc(duration(c.minutes))} of work, ${esc(count(c.left, 'unit'))} left (an unfinished unit counts as ${esc(duration(c.estimate))}, the median of finished ones, or its time so far if longer)</span></p>` : '';
  const kinds = (k) => g.edges.filter((e) => e.kind === k).length;
  return say + counts([[units.length, units.length === 1 ? 'unit' : 'units'], [refs.length, 'issues and PRs'], [fus.length, fus.length === 1 ? 'follow-up' : 'follow-ups'], [kinds('after'), 'waits on'], [g.edges.length, g.edges.length === 1 ? 'line' : 'lines']])
    + (ctx.live ? navTools('flow', 'unit, issue or follow-up') : '')
    + svg(width, height, 'Flow map: stacked units, linked issues and PRs, follow-ups, and the critical path', `${defs}${heads}${nav.hitLayers()}<g class="edges">${edges}</g>${nodes}`, ' flow', ' data-nav="flow"')
    + `<style>${nav.rules('flow')}</style>`
    + lineKey([['after', 'waits on: the arrow points to the unit it waits for (--after)'], ['crit', 'waits on, on the critical path'], ['link', 'links an issue or PR: a ring at the issue end'], ['fu', 'filed a follow-up: an open arrowhead at the follow-up']])
    + legend([['ref cross', 'another repo']])
    + marksLegend() + navHelp(!!ctx.live);
}

const hh = (iso) => iso.slice(11, 13);
const day = (iso) => iso.slice(5, 10);
const plural = (n, one) => count(n, one);

export function heatSvg(v, ctx, nowMs = Date.now()) {
  const h = heat(v, nowMs);
  if (!h.rows.length) return empty('No units yet.');
  const ix = unitIndex(v); const nb = neighbours(v); const st0 = new Map(v.units.map((u) => [u.id, u.status]));
  const LW = 112; const n = h.cols.length;
  const cw = Math.max(12, Math.min(28, Math.floor(760 / n))); const ch = 22; const top = 36;
  const every = Math.ceil(48 / cw);
  const heads = h.cols.map((c, i) => {
    const newDay = i === 0 || day(c.at) !== day(h.cols[i - 1].at);
    return (newDay ? txt(LW + i * cw, 12, day(c.at), 'xs muted') : '') + (i % every === 0 ? txt(LW + i * cw, 28, `${hh(c.at)}:00`, 'xs muted') : '');
  }).join('');
  const span = (i) => `${h.cols[i].at.slice(5, 16).replace('T', ' ')}–${new Date(Date.parse(h.cols[i].at) + h.step * 3_600_000).toISOString().slice(11, 16)} UTC`;
  const cellSay = (c) => [c.rounds && `${plural(c.rounds, 'try')}${c.fails ? ` (${c.fails} failed)` : ''}`, c.beats && plural(c.beats, 'heartbeat'), c.other && plural(c.other, 'other event'), c.waitMin && `waited ${duration(c.waitMin)}`].filter(Boolean).join(', ') || 'nothing';
  const rows = h.rows.map((r, j) => {
    const y = top + j * (ch + 4);
    const t = r.total;
    const busiest = r.cells.reduce((b, c, i) => (c.level > r.cells[b].level ? i : b), 0);
    const label = `${r.unit}: ${plural(t.rounds, 'try')}${t.fails ? ` (${t.fails} failed)` : ''}, ${plural(t.beats, 'heartbeat')}, waited ${duration(t.waitMin)}${r.cells[busiest].level ? `; busiest ${span(busiest)}` : ''}`;
    const cells = r.cells.map((c, i) => `<rect class="hc h-${c.kind} l${c.level}" x="${LW + i * cw}" y="${y}" width="${cw - 2}" height="${ch}" rx="3"><title>${esc(`${r.unit}, ${span(i)}: ${cellSay(c)}`)}</title></rect>`).join('');
    return link(ctx.unitHref(r.unit), label, `${txt(8, y + 15, `${mark(st0.get(r.unit))} ${clip(r.unit, 11)}`, 'b')}${cells}`, false, ix.has(r.unit) ? boxAttrs(ix.get(r.unit), nb.get(ix.get(r.unit))) : '');
  }).join('');
  const width = LW + n * cw + P; const height = top + h.rows.length * (ch + 4) + P;
  return `<p class="map-say cause">One column per ${h.step === 1 ? 'hour' : `${h.step} hours`} since the run started, in UTC. Darker means more happened: tries count double, heartbeats and other events once. Red holds a failed try; amber is time spent waiting for a critic or an answer.</p>`
    + svg(width, height, 'Heatmap: units against time', heads + rows, ' heat')
    + legend([['h-none', 'nothing'], ['h-busy l1', 'a little'], ['h-busy l4', 'a lot'], ['h-fail l3', 'a failed try'], ['h-wait', 'waiting']]);
}

const MARK = { pass: '✓', fail: '✗', unchecked: '·' };
export function behaviourSvg(v, ctx) {
  const b = behaviourGrid(v);
  if (!b.cols) return empty('No behaviours yet: add them with add --behaviour or behave.');
  const ix = unitIndex(v); const nb = neighbours(v); const st0 = new Map(v.units.map((u) => [u.id, u.status]));
  const LW = 112; const cw = 52; const ch = 24; const top = 22;
  const heads = Array.from({ length: b.cols }, (_, i) => txt(LW + i * cw + (cw - 4) / 2, 14, String(i + 1), 'xs muted', 'middle')).join('');
  const rows = b.rows.map((r, j) => {
    const y = top + j * (ch + 4);
    const label = `${r.label}: ${r.cells.map((c) => `${c.id} ${c.status}`).join(', ')}`;
    const cells = r.cells.map((c, i) => `<g><title>${esc(`${r.label} ${c.id}: ${c.status} — ${clip(c.text, 160)}`)}</title><rect class="nd ${st(c.status)}" x="${LW + i * cw}" y="${y}" width="${cw - 4}" height="${ch}" rx="4"/>${txt(LW + i * cw + (cw - 4) / 2, y + 16, `${MARK[c.status] ?? ''}${c.id}`, 'xs', 'middle')}</g>`).join('');
    const unit = r.unit && ix.has(r.unit);
    return link(r.unit ? ctx.unitHref(r.unit) : ctx.home, label, `${txt(8, y + 16, unit ? `${mark(st0.get(r.unit))} ${clip(r.label, 11)}` : clip(r.label, 13), 'b')}${cells}`, false, unit ? boxAttrs(ix.get(r.unit), nb.get(ix.get(r.unit))) : '');
  }).join('');
  return `<p class="map-say cause">${b.pass} pass, ${b.fail} fail, ${b.unchecked} unchecked.</p>`
    + svg(LW + b.cols * cw + P, top + b.rows.length * (ch + 4) + P, 'Heatmap: units against behaviours', heads + rows, ' grid')
    + legend([['st-pass', '✓ pass'], ['st-fail', '✗ fail'], ['st-unchecked', '· unchecked']]);
}

export function relevanceSvg(v, ctx) {
  const r = relevance(v);
  if (!r.units.length) return empty('No units yet.');
  const ix = unitIndex(v); const st0 = new Map(v.units.map((u) => [u.id, u.status]));
  const servedBy = new Map(r.targets.map((t) => [t.id, r.units.filter((u) => u.serves.some((x) => x.target === t.id)).map((u) => u.unit)]));
  const TW = 260; const UW2 = 190; const H = 40; const G = 12; const ux = P + TW + 110;
  const on = r.units.filter((u) => !u.off); const off = r.units.filter((u) => u.off);
  const tY = new Map(r.targets.map((t, i) => [t.id, TOP + i * (H + G)]));
  const uY = new Map([...on.map((u, i) => [u.unit, TOP + i * (H + G)]), ...off.map((u, i) => [u.unit, TOP + (on.length + i) * (H + G) + 30])]);
  // A goal behaviour's children are the units that serve it.
  const lines = r.units.flatMap((u) => u.serves.map((s) => ({ from: `t:${s.target}`, to: `u:${u.unit}`, how: s.how, unit: u.unit, target: s.target })));
  const nav = navGraph([...r.targets.map((t) => `t:${t.id}`), ...r.units.map((u) => `u:${u.unit}`)], lines);
  const port = ports(lines, (k) => ({ y: k.startsWith('t:') ? tY.get(k.slice(2)) : uY.get(k.slice(2)), h: H }));
  const edges = lines.map((e, m) => { const [y1, y2] = port(m); const d = bez(P + TW, y1, ux, y2);
    return nav.edge(m, e, `${e.unit} serves ${e.target === 'goal' ? 'the goal' : e.target} (${e.how === 'named' ? 'named' : 'shared words'})`, d, line2(d, e.how === 'named' ? 'named' : 'inferred')); });
  const targets = r.targets.map((t) => link(ctx.home, `${t.label}: ${said(t.status)} — ${clip(t.text, 200)}`, `<rect class="nd ${st(t.status)}" x="${P}" y="${tY.get(t.id)}" width="${TW}" height="${H}" rx="8"/>${txt(P + 10, tY.get(t.id) + 17, clip(`${t.label}: ${t.text}`, 36), 'sm')}${txt(P + 10, tY.get(t.id) + 33, clip(servedBy.get(t.id).length ? `served by ${servedBy.get(t.id).join(', ')}` : 'no unit serves it', 44), 'xs muted')}`, false,
    nav.node(`t:${t.id}`, 'hl', ` data-name="${esc(t.label)}" data-kind="goal"`))).join('');
  const units = r.units.map((u) => {
    const y = uY.get(u.unit); const i = ix.get(u.unit);
    const how = u.off ? 'off goal' : u.distance === 0 ? `named · ${u.serves.length} of ${r.targets.length}` : `inferred · ${u.serves.length} of ${r.targets.length}`;
    return link(ctx.unitHref(u.unit), `${u.unit}: ${how}${u.title ? ` — ${clip(u.title, 120)}` : ''}`, `<rect class="nd ${st(u.status)}${u.off ? ' off' : ''}" x="${ux}" y="${y}" width="${UW2}" height="${H}" rx="8"/>${txt(ux + 10, y + 17, `${mark(st0.get(u.unit))} ${clip(`${u.unit}${u.title ? ` · ${u.title}` : ''}`, 22)}`, 'b')}${txt(ux + 10, y + 33, how, 'xs muted')}`, false,
      nav.node(`u:${u.unit}`, `u u${i} hl`, ` aria-describedby="${tipId(i)}" data-name="${esc(u.unit)}" data-kind="unit"`));
  }).join('');
  const offHead = off.length ? txt(ux, TOP + on.length * (H + G) + 18, 'Off goal', 'h warn') : '';
  const height = TOP + r.units.length * (H + G) + (off.length ? 30 : 0) + P;
  const say = `<p class="map-say">${esc(`${on.length} of ${count(r.units.length, 'unit')} ${on.length === 1 ? 'serves' : 'serve'} the goal`)}${off.length ? `; off goal: ${off.map((u) => `<a href="${esc(ctx.unitHref(u.unit))}">${esc(u.unit)}</a>`).join(', ')}` : ''}. <span class="cause">Named: the unit names the ${v.goalCheck.behaviours.length ? 'behaviour id' : 'goal’s issue or the goal names the unit'}. Inferred: they share words.</span></p>`;
  const named = lines.filter((e) => e.how === 'named').length;
  return say + counts([[r.targets.length, r.targets.length === 1 ? 'goal target' : 'goal behaviours'], [on.length, 'on goal'], [off.length, 'off goal'], [named, 'named lines'], [lines.length - named, 'shared-word lines']])
    + (ctx.live ? navTools('rel', 'goal behaviour or unit') : '')
    + svg(ux + UW2 + P, Math.max(height, TOP + r.targets.length * (H + G) + P), 'Goal relevance: which goal behaviours each unit serves', `${txt(P, 20, v.goalCheck.behaviours.length ? 'Goal behaviours' : 'Goal', 'h')}${txt(ux, 20, 'Units', 'h')}${nav.hitLayers()}<g class="edges">${edges.join('')}</g>${targets}${offHead}${units}`, ' rel', ' data-nav="rel"')
    + `<style>${nav.rules('rel')}</style>`
    + lineKey([['named', 'serves it (named)'], ['inferred', 'serves it (shared words)']]) + legend([['off', 'off goal']]) + `<p class="map-legend"><span class="cause">No arrowheads here: every line runs from a goal behaviour on the left to a unit that serves it on the right.</span></p>` + navHelp(!!ctx.live);
}
