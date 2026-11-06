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

const r1 = (n) => Math.round(n * 10) / 10;
const st = (s) => `st-${String(s ?? '').toLowerCase().replace(/[^a-z-]/g, '')}`;
const STATUS = { ...DOTS, met: 'met', 'not-yet': 'not met yet', pass: 'pass', fail: 'fail', unchecked: 'unchecked', evidence: 'evidence' };
const said = (s) => STATUS[s] ?? s;

// A focusable link around a shape. Internal hrefs come from ctx (already encoded); external ones must be http(s).
export function link(href, label, inner, external = false) {
  const url = external ? webUrl(href) : href;
  if (!url) return `<g role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${inner}</g>`;
  return `<a href="${esc(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''} aria-label="${esc(label)}"><title>${esc(label)}</title>${inner}</a>`;
}
const svg = (w, h, label, body, cls = '') => `<div class="map-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><svg class="map${cls}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="${Math.ceil(w)}" style="min-width:${Math.min(Math.ceil(w), Math.ceil(w * 0.62))}px" role="group" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${body}</svg></div>`;
const txt = (x, y, s, cls = '', anchor = '') => `<text x="${r1(x)}" y="${r1(y)}"${cls ? ` class="${cls}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
const empty = (t) => `<p class="empty">${esc(t)}</p>`;
const legend = (items) => `<p class="map-legend">${items.map(([c, l]) => `<span><i class="sw ${c}" aria-hidden="true"></i>${esc(l)}</span>`).join('')}</p>`;

// Goal at the centre; units on the first ring, their behaviours on the second, evidence outside.
export function mindSvg(v, ctx) {
  const g = mindGraph(v);
  const units = g.nodes.filter((n) => n.kind === 'unit');
  if (!units.length) return empty('No units yet.');
  const kids = (id) => g.nodes.filter((n) => n.parent === id);
  const hasB = g.nodes.some((n) => n.kind !== 'goal' && n.kind !== 'unit');
  const R1 = hasB ? 150 : 190; const R2 = R1 + 115; const R3 = R2 + 60;
  // Drawn twice: once to measure, once placed so the picture fills its box (one unit needs no full circle).
  const draw = (cx, cy) => {
    const at = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const sector = Math.min((2 * Math.PI) / units.length, Math.PI * 0.9) * 0.82;
    const spread = (k, m, mid, width) => (m < 2 ? mid : mid - width / 2 + (k * width) / (m - 1));
    const labels = g.nodes.filter((n) => n.kind === 'behaviour').length <= 48;
    const edges = []; const nodes = []; const pts = [];
    const leaf = (n, x, y, a) => {
      pts.push([x, y, n.kind === 'behaviour' && labels ? 34 : 12]);
      const unitHref = ctx.unitHref(n.unit);
      if (n.kind === 'behaviour') {
        nodes.push(link(unitHref, `${n.unit} ${n.label}: ${said(n.status)} — ${clip(n.text, 160)}`, `<circle class="nd ${st(n.status)}" cx="${r1(x)}" cy="${r1(y)}" r="9"/>`
          + (labels ? txt(cx + (R2 + 16) * Math.cos(a), cy + (R2 + 16) * Math.sin(a) + 4, n.label, 'sm', Math.cos(a) < -0.2 ? 'end' : Math.cos(a) > 0.2 ? 'start' : 'middle') : '')));
      } else {
        const href = n.url ? n.url : n.file ? ctx.artHref(n.file) : unitHref;
        const shape = n.kind === 'more' ? `<circle class="nd ev" cx="${r1(x)}" cy="${r1(y)}" r="9"/>${txt(x, y + 3, n.label, 'xs', 'middle')}` : `<circle class="nd ev" cx="${r1(x)}" cy="${r1(y)}" r="4.5"/>`;
        nodes.push(link(href, `${n.unit} evidence (${n.label}): ${clip(n.text, 160)}`, shape, !!n.url));
      }
    };
    units.forEach((u, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / units.length;
      const [x, y] = at(R1, a); pts.push([x, y, 30]);
      edges.push(`<line class="edge" x1="${r1(cx)}" y1="${r1(cy)}" x2="${r1(x)}" y2="${r1(y)}"/>`);
      const ks = kids(u.id);
      ks.forEach((k, j) => {
        const ka = spread(j, ks.length, a, sector); const [kx, ky] = at(R2, ka);
        edges.push(`<line class="edge" x1="${r1(x)}" y1="${r1(y)}" x2="${r1(kx)}" y2="${r1(ky)}"/>`);
        leaf(k, kx, ky, ka);
        const es = kids(k.id);
        es.forEach((e, m) => {
          const ea = spread(m, es.length, ka, (sector / Math.max(1, ks.length)) * 0.8); const [ex, ey] = at(R3, ea);
          edges.push(`<line class="edge" x1="${r1(kx)}" y1="${r1(ky)}" x2="${r1(ex)}" y2="${r1(ey)}"/>`);
          leaf(e, ex, ey, ea);
        });
      });
      nodes.push(link(ctx.unitHref(u.unit), `${u.unit}: ${said(u.status)}${u.text ? ` — ${clip(u.text, 160)}` : ''}`, `<circle class="nd ${st(u.status)}" cx="${r1(x)}" cy="${r1(y)}" r="27"/>${txt(x, y + 4, clip(u.label, 9), 'b', 'middle')}`));
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
    + legend([['st-working', 'working'], ['st-waiting', 'waiting or retrying'], ['st-stale', 'quiet'], ['st-passed', 'passed'], ['st-stopped', 'stopped'], ['st-pass', 'behaviour pass'], ['st-fail', 'behaviour fail'], ['st-unchecked', 'unchecked'], ['ev', 'evidence']]);
}

const UW = 172; const UH = 46; const RW = 176; const RH = 32; const FW = 240; const FH = 40; const GX = 64; const GY = 14; const P = 16; const TOP = 34;

// Places nodes in a column near a target y each, top to bottom, never overlapping. No target (Infinity): at the end.
function stack(list, h, gap) {
  let y = TOP;
  return [...list].sort((a, b) => a.want - b.want).map((n) => { const at = Number.isFinite(n.want) ? Math.max(y, n.want) : y; y = at + h + gap; return { ...n, y: at }; });
}
const curve = (x1, y1, x2, y2, cls, end = '') => { const dx = Math.max(24, (x2 - x1) / 2); return `<path class="edge ${cls}"${end ? ` marker-end="url(#${end})"` : ''} d="M${r1(x1)} ${r1(y1)} C${r1(x1 + dx)} ${r1(y1)} ${r1(x2 - dx)} ${r1(y2)} ${r1(x2)} ${r1(y2)}"/>`; };

export function flowSvg(v, ctx, nowMs = Date.now()) {
  const g = flowGraph(v, nowMs);
  const units = g.nodes.filter((n) => n.kind === 'unit');
  if (!units.length) return empty('No units yet.');
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
  const edge = (e) => { const a = pos.get(e.from); const b = pos.get(e.to); return curve(a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2, `${e.kind}${e.crit ? ' crit' : ''}`, e.crit ? 'flow-arrow-crit' : 'flow-arrow'); };
  // Follow-up edges cross the issue column, so they go above its nodes.
  const edges = g.edges.filter((e) => e.kind !== 'follow-up').map(edge);
  const late = g.edges.filter((e) => e.kind === 'follow-up').map(edge).join('');
  const heads = [txt(P, 20, D ? 'Units, stacked left to right' : 'Units', 'h'), refs.length ? txt(refX, 20, 'Issues and PRs', 'h') : '', fus.length ? txt(fuX, 20, 'Follow-ups', 'h') : ''].join('');
  const nodeOf = ({ x: nx, y, w, h, n }) => {
    if (n.kind === 'unit') {
      const label = `${n.unit}: ${said(n.status)}${n.crit ? ', on the critical path' : ''}${n.title ? ` — ${clip(n.title, 120)}` : ''}`;
      return link(ctx.unitHref(n.unit), label, `<rect class="nd ${st(n.status)}${n.crit ? ' crit' : ''}" x="${nx}" y="${y}" width="${w}" height="${h}" rx="8"/>${txt(nx + 10, y + 19, clip(n.label, 20), 'b')}${txt(nx + 10, y + 36, clip(n.title, 26), 'sm muted')}`);
    }
    if (n.kind === 'follow-up') return link(n.url ?? ctx.home, `Follow-up${n.units.length ? ` from ${n.units.join(', ')}` : ''}: ${clip(n.text, 200)}`, `<rect class="nd fu" x="${nx}" y="${y}" width="${w}" height="${h}" rx="6"/>${txt(nx + 10, y + 16, n.label, 'xs muted')}${txt(nx + 10, y + 32, clip(n.text, 36), 'sm')}`, !!n.url);
    const what = n.kind === 'pr' ? 'PR' : 'Issue';
    return link(n.url, `${what} ${n.repo}#${n.label.split('#')[1]}${n.cross ? ' (another repo)' : ''}, linked by ${n.units.join(', ')}`, `<rect class="nd ref${n.cross ? ' cross' : ''}" x="${nx}" y="${y}" width="${w}" height="${h}" rx="16"/>${txt(nx + 12, y + 20, clip(`${what} ${n.label}`, 26), 'sm')}`, true);
  };
  const placed = [...pos.values()];
  const nodes = placed.filter((p) => p.n.kind !== 'follow-up').map(nodeOf).join('') + `<g aria-hidden="true">${late}</g>` + placed.filter((p) => p.n.kind === 'follow-up').map(nodeOf).join('');
  const defs = '<defs>' + [['flow-arrow', 'arrow'], ['flow-arrow-crit', 'arrow crit']].map(([id, cls]) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${cls}" d="M0 0 10 5 0 10z"/></marker>`).join('') + '</defs>';
  const c = g.critical;
  const say = !c.stacked ? '<p class="map-say cause">No stacked work: the units run side by side, so there is no critical path.</p>' : c.path.length
    ? `<p class="map-say"><b>Critical path:</b> ${c.path.map((id) => `<a href="${esc(ctx.unitHref(id))}">${esc(id)}</a>`).join(' → ')} <span class="cause">· about ${esc(duration(c.minutes))} of work, ${esc(count(c.left, 'unit'))} left (an unfinished unit counts as ${esc(duration(c.estimate))}, the median of finished ones, or its time so far if longer)</span></p>` : '';
  return say + svg(width, height, 'Flow map: stacked units, linked issues and PRs, follow-ups, and the critical path', `${defs}${heads}<g aria-hidden="true">${edges.join('')}</g>${nodes}`, ' flow')
    + legend([['ln-after', 'stacked (--after)'], ['ln-crit', 'critical path'], ['ln-link', 'linked issue or PR'], ['ln-fu', 'follow-up'], ['ref cross', 'another repo']]);
}

const hh = (iso) => iso.slice(11, 13);
const day = (iso) => iso.slice(5, 10);
const plural = (n, one) => count(n, one);

export function heatSvg(v, ctx, nowMs = Date.now()) {
  const h = heat(v, nowMs);
  if (!h.rows.length) return empty('No units yet.');
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
    return link(ctx.unitHref(r.unit), label, `${txt(8, y + 15, clip(r.unit, 13), 'b')}${cells}`);
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
  const LW = 112; const cw = 52; const ch = 24; const top = 22;
  const heads = Array.from({ length: b.cols }, (_, i) => txt(LW + i * cw + (cw - 4) / 2, 14, String(i + 1), 'xs muted', 'middle')).join('');
  const rows = b.rows.map((r, j) => {
    const y = top + j * (ch + 4);
    const label = `${r.label}: ${r.cells.map((c) => `${c.id} ${c.status}`).join(', ')}`;
    const cells = r.cells.map((c, i) => `<g><title>${esc(`${r.label} ${c.id}: ${c.status} — ${clip(c.text, 160)}`)}</title><rect class="nd ${st(c.status)}" x="${LW + i * cw}" y="${y}" width="${cw - 4}" height="${ch}" rx="4"/>${txt(LW + i * cw + (cw - 4) / 2, y + 16, `${MARK[c.status] ?? ''}${c.id}`, 'xs', 'middle')}</g>`).join('');
    return link(r.unit ? ctx.unitHref(r.unit) : ctx.home, label, `${txt(8, y + 16, clip(r.label, 13), 'b')}${cells}`);
  }).join('');
  return `<p class="map-say cause">${b.pass} pass, ${b.fail} fail, ${b.unchecked} unchecked.</p>`
    + svg(LW + b.cols * cw + P, top + b.rows.length * (ch + 4) + P, 'Heatmap: units against behaviours', heads + rows, ' grid')
    + legend([['st-pass', '✓ pass'], ['st-fail', '✗ fail'], ['st-unchecked', '· unchecked']]);
}

export function relevanceSvg(v, ctx) {
  const r = relevance(v);
  if (!r.units.length) return empty('No units yet.');
  const TW = 260; const UW2 = 190; const H = 40; const G = 12; const ux = P + TW + 110;
  const on = r.units.filter((u) => !u.off); const off = r.units.filter((u) => u.off);
  const tY = new Map(r.targets.map((t, i) => [t.id, TOP + i * (H + G)]));
  const uY = new Map([...on.map((u, i) => [u.unit, TOP + i * (H + G)]), ...off.map((u, i) => [u.unit, TOP + (on.length + i) * (H + G) + (on.length ? 30 : 0)])]);
  const edges = r.units.flatMap((u) => u.serves.map((s) => curve(P + TW, tY.get(s.target) + H / 2, ux, uY.get(u.unit) + H / 2, s.how === 'named' ? 'named' : 'inferred')));
  const targets = r.targets.map((t) => link(ctx.home, `${t.label}: ${said(t.status)} — ${clip(t.text, 200)}`, `<rect class="nd ${st(t.status)}" x="${P}" y="${tY.get(t.id)}" width="${TW}" height="${H}" rx="8"/>${txt(P + 10, tY.get(t.id) + 25, clip(`${t.label}: ${t.text}`, 36), 'sm')}`)).join('');
  const units = r.units.map((u) => {
    const y = uY.get(u.unit);
    const how = u.off ? 'off goal' : u.distance === 0 ? `named · ${u.serves.length} of ${r.targets.length}` : `inferred · ${u.serves.length} of ${r.targets.length}`;
    return link(ctx.unitHref(u.unit), `${u.unit}: ${how}${u.title ? ` — ${clip(u.title, 120)}` : ''}`, `<rect class="nd ${st(u.status)}${u.off ? ' off' : ''}" x="${ux}" y="${y}" width="${UW2}" height="${H}" rx="8"/>${txt(ux + 10, y + 17, clip(u.unit, 22), 'b')}${txt(ux + 10, y + 33, how, 'xs muted')}`);
  }).join('');
  const offHead = off.length ? txt(ux, TOP + on.length * (H + G) + (on.length ? 18 : -8), 'Off goal', 'h warn') : '';
  const height = TOP + r.units.length * (H + G) + (on.length && off.length ? 30 : 0) + P;
  const say = `<p class="map-say">${esc(`${on.length} of ${count(r.units.length, 'unit')} ${on.length === 1 ? 'serves' : 'serve'} the goal`)}${off.length ? `; off goal: ${off.map((u) => `<a href="${esc(ctx.unitHref(u.unit))}">${esc(u.unit)}</a>`).join(', ')}` : ''}. <span class="cause">Named: the unit names the ${v.goalCheck.behaviours.length ? 'behaviour id' : 'goal’s issue or the goal names the unit'}. Inferred: they share words.</span></p>`;
  return say + svg(ux + UW2 + P, Math.max(height, TOP + r.targets.length * (H + G) + P), 'Goal relevance: which goal behaviours each unit serves', `${txt(P, 20, v.goalCheck.behaviours.length ? 'Goal behaviours' : 'Goal', 'h')}${txt(ux, 20, 'Units', 'h')}<g aria-hidden="true">${edges.join('')}</g>${targets}${offHead}${units}`, ' rel')
    + legend([['ln-named', 'named'], ['ln-inferred', 'inferred'], ['off', 'off goal']]);
}
