// The project map as a page: a layered import graph in inline SVG, then
// surfaces, settings, shared helpers and reuse candidates. Filters (areas,
// edge weight, tests) are checkboxes read by CSS :has(), so the static
// map.html needs no script. Nodes and rows link to the files on GitHub when
// the repo is known. Same shell and theme as the dashboard (lib/parts.mjs).
import { anchor, esc } from '../links.mjs';
import { blk, chip, page, toggle } from '../parts.mjs';
import { TEST } from './js.mjs';

const MAX_NODES = 60;
const FILE_NODES = 80; // up to this many modules, one node per file
const ROWS = 150;
const W = 190; const H = 30; const GAP_X = 110; const GAP_Y = 10; const PAD = 16;

// Group key of a file: itself (small maps) or its folder cut at `depth`.
const folder = (f, depth) => { const parts = f.split('/'); parts.pop(); return parts.slice(0, depth).join('/') || '.'; };

export function grouping(modules) {
  if (modules.length <= FILE_NODES) return { level: 'file', key: (f) => f };
  let best = 1;
  for (let d = 1; d <= 8; d++) {
    const n = new Set(modules.map((m) => folder(m.id, d))).size;
    if (n <= MAX_NODES) best = d; else break;
  }
  return { level: 'folder', key: (f) => folder(f, best) };
}

// Nodes, weighted edges and a layered layout: importers left, what they import right.
export function graph(snap) {
  const g = grouping(snap.modules);
  const nodes = new Map();
  const node = (k) => { if (!nodes.has(k)) nodes.set(k, { key: k, files: 0, tests: 0, routes: 0, screens: 0, helpers: 0, settings: 0, out: new Map(), in: new Set() }); return nodes.get(k); };
  for (const m of snap.modules) { const n = node(g.key(m.id)); n.files++; if (TEST.test(m.id)) n.tests++; }
  for (const m of snap.modules) {
    const a = node(g.key(m.id));
    for (const to of m.imports) { const b = g.key(to); if (b === a.key || !nodes.has(b)) continue; a.out.set(b, (a.out.get(b) ?? 0) + 1); nodes.get(b).in.add(a.key); }
  }
  for (const s of snap.surfaces) if (s.file && nodes.has(g.key(s.file))) { const n = nodes.get(g.key(s.file)); if (s.kind === 'route') n.routes++; else if (s.kind === 'screen') n.screens++; }
  for (const h of snap.helpers) if (nodes.has(g.key(h.file))) nodes.get(g.key(h.file)).helpers++;
  for (const s of snap.settings) for (const r of [...s.reads, ...s.writes]) { const k = g.key(r.slice(0, r.lastIndexOf(':'))); if (nodes.has(k)) nodes.get(k).settings++; }

  // Back edges (cycles) by DFS; the rest is a DAG ranked by longest path.
  const keys = [...nodes.keys()].sort();
  const state = new Map(); const back = new Set();
  const dfs = (k) => {
    state.set(k, 1);
    for (const to of [...nodes.get(k).out.keys()].sort()) {
      if (state.get(to) === 1) back.add(`${k}>${to}`); else if (!state.has(to)) dfs(to);
    }
    state.set(k, 2);
  };
  for (const k of keys) if (!state.has(k)) dfs(k);
  const rank = new Map();
  const rankOf = (k, seen = new Set()) => {
    if (rank.has(k)) return rank.get(k);
    seen.add(k);
    let r = 0;
    for (const from of nodes.get(k).in) if (!back.has(`${from}>${k}`) && !seen.has(from)) r = Math.max(r, rankOf(from, seen) + 1);
    rank.set(k, r);
    return r;
  };
  for (const k of keys) rankOf(k);
  const cols = [];
  for (const k of keys) (cols[rank.get(k)] ??= []).push(k);
  // Order each column by the mean row of what imports it (two passes).
  const row = new Map();
  cols.forEach((c) => c.forEach((k, i) => row.set(k, i)));
  for (let pass = 0; pass < 2; pass++) {
    for (const c of cols.slice(1)) {
      const bary = (k) => { const ins = [...nodes.get(k).in].filter((f) => row.has(f) && rank.get(f) < rank.get(k)); return ins.length ? ins.reduce((s, f) => s + row.get(f), 0) / ins.length : row.get(k); };
      c.sort((a, b) => bary(a) - bary(b) || (a < b ? -1 : 1)).forEach((k, i) => row.set(k, i));
    }
  }
  const pos = new Map();
  cols.forEach((c, x) => c.forEach((k, y) => pos.set(k, { x: PAD + x * (W + GAP_X), y: PAD + y * (H + GAP_Y) })));
  const edges = [];
  for (const [k, n] of nodes) for (const [to, w] of n.out) edges.push({ from: k, to, w, back: back.has(`${k}>${to}`) });
  const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * GAP_X;
  const height = PAD * 2 + Math.max(1, ...cols.map((c) => c.length)) * (H + GAP_Y) - GAP_Y;
  return { level: g.level, key: g.key, nodes, keys, pos, edges, width, height, area: (k) => k.split('/')[0] };
}

const ghBase = (snap) => (snap.build?.repo ? `https://github.com/${snap.build.repo}` : null);
const ref = (snap) => (snap.build?.commit && snap.build?.pushed ? snap.build.commit : 'HEAD');
export function fileUrl(snap, file, line = null) {
  const base = ghBase(snap);
  if (!base) return null;
  return `${base}/blob/${ref(snap)}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;
}
const treeUrl = (snap, dir) => (ghBase(snap) ? `${ghBase(snap)}/tree/${ref(snap)}/${dir === '.' ? '' : dir.split('/').map(encodeURIComponent).join('/')}` : null);
const fileLink = (snap, file, line = null, label = null) => { const u = fileUrl(snap, file, line); const text = label ?? `${file}${line ? `:${line}` : ''}`; return u ? anchor(u, text) : `<code>${esc(text)}</code>`; };
const refLink = (snap, r) => { const i = r.lastIndexOf(':'); return fileLink(snap, r.slice(0, i), Number(r.slice(i + 1)) || null); };
const few = (items, n = 4) => items.slice(0, n).join('<br>') + (items.length > n ? `<br><span class="meta">+${items.length - n} more</span>` : '');
const clipLabel = (s, n = 26) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);

function svg(snap, gr, areaIds) {
  const id = new Map(gr.keys.map((k, i) => [k, i]));
  const cls = (k) => `a${areaIds.get(gr.area(k))}`;
  const edgeSvg = gr.edges.map((e) => {
    const a = gr.pos.get(e.from); const b = gr.pos.get(e.to);
    const x1 = a.x + W; const y1 = a.y + H / 2; const x2 = b.x; const y2 = b.y + H / 2;
    const d = e.back || x2 <= x1 ? `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 40} ${b.x + W / 2},${b.y + H + 40} ${b.x + W / 2},${b.y + H}`
      : `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`;
    const wc = e.w >= 10 ? 'w10' : e.w >= 3 ? 'w3' : 'w1';
    const t = gr.nodes.get(e.from).tests === gr.nodes.get(e.from).files ? ' t' : '';
    return `<path class="e ${wc} x${id.get(e.from)} x${id.get(e.to)} ea${areaIds.get(gr.area(e.from))} eb${areaIds.get(gr.area(e.to))}${e.back ? ' back' : ''}${t}" d="${d}" stroke-width="${Math.min(5, 1 + Math.log2(e.w)).toFixed(1)}"><title>${esc(`${e.from} → ${e.to}: ${e.w} import${e.w === 1 ? '' : 's'}${e.back ? ' (cycle)' : ''}`)}</title></path>`;
  }).join('');
  const nodeSvg = gr.keys.map((k) => {
    const n = gr.nodes.get(k); const p = gr.pos.get(k); const i = id.get(k);
    const facts = [`${n.files} file${n.files === 1 ? '' : 's'}`, n.routes && `${n.routes} routes`, n.screens && `${n.screens} screens`, n.helpers && `${n.helpers} shared helpers`, n.settings && `${n.settings} setting uses`].filter(Boolean).join(' · ');
    const label = gr.level === 'file' ? k.split('/').pop() : k;
    const badge = n.routes || n.screens ? `<circle class="s" cx="${p.x + W - 9}" cy="${p.y + 9}" r="4"/>` : '';
    const body = `<g class="n ${cls(k)}${n.tests === n.files ? ' t' : ''}" id="n${i}"><title>${esc(`${k}\n${facts}`)}</title><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="6"/>`
      + `<text x="${p.x + 8}" y="${p.y + 19}">${esc(clipLabel(label))}</text>${badge}</g>`;
    const url = gr.level === 'file' ? fileUrl(snap, k) : treeUrl(snap, k);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${k}: ${facts}`)}">${body}</a>` : body;
  }).join('');
  return `<svg class="graph" width="${gr.width}" height="${gr.height + 40}" viewBox="0 0 ${gr.width} ${gr.height + 40}" role="img" aria-label="${esc(`Import graph: ${gr.keys.length} ${gr.level === 'file' ? 'files' : 'folders'}, ${gr.edges.length} links`)}">${edgeSvg}${nodeSvg}</svg>`;
}

// Hover or focus on a node lights its links; unchecked areas, light edges and tests hide.
function styles(gr, areaIds) {
  const per = gr.keys.map((k, i) => `:root .graph:has(#n${i}:hover) .x${i},:root .graph:has(a:focus-visible #n${i}) .x${i}{stroke:var(--run);opacity:1}`).join('');
  const areas = [...areaIds.values()].map((i) => `:root:has(#f-a${i}:not(:checked)) :is(.a${i},.ea${i},.eb${i}){display:none}`).join('');
  return `<style>
.mapbox{overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);max-height:70vh}
.graph .n rect{fill:var(--card);stroke:var(--line);stroke-width:1.2}.graph .n text{fill:var(--ink);font:12px var(--mono)}
.graph .n:hover rect,.graph a:focus-visible rect{stroke:var(--run);stroke-width:2}.graph .s{fill:var(--pass)}
.graph .e{fill:none;stroke:var(--muted);opacity:.45}.graph .e.back{stroke-dasharray:4 3;stroke:var(--wait)}
.graph:has(.n:hover) .e{opacity:.12}
:root:has(#f-cycles:not(:checked)) .e.back{opacity:0}
:root:has(#f-w3:checked) .e.w1,:root:has(#f-w10:checked) :is(.e.w1,.e.w3){display:none}
:root:has(#f-tests:not(:checked)) .t{display:none}
.maptable{width:100%;border-collapse:collapse;font-size:13px}.maptable th,.maptable td{text-align:left;padding:5px 8px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.maptable code{font:12px var(--mono)}.mapfilters{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--muted);margin:10px 0}
.mapfilters fieldset{display:flex;flex-wrap:wrap;gap:6px;border:0;padding:0;margin:0;align-items:center}.mapfilters legend{float:left;margin-right:6px}
${per}${areas}</style>`;
}

function rows(list, render, head, rowClass = () => '') {
  const shown = list.slice(0, ROWS);
  const body = shown.map((x) => `<tr class="${rowClass(x)}">${render(x).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return list.length ? `<table class="maptable"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>${list.length > ROWS ? `<p class="meta">Showing ${ROWS} of ${list.length}; the rest are in map.json.</p>` : ''}`
    : '<p class="empty">None found.</p>';
}

export function mapPage(snap, ctx, run) {
  const b = snap.build ?? {};
  const gr = graph(snap);
  const areas = [...new Set(gr.keys.map(gr.area))].sort();
  const areaIds = new Map(areas.map((a, i) => [a, i]));
  const rowArea = (file) => { const i = areaIds.get(gr.area(gr.key(file))); return `${i === undefined ? '' : `a${i}`}${TEST.test(file) ? ' t' : ''}`; };
  const commit = b.commit ? (ghBase(snap) && b.pushed ? anchor(`${ghBase(snap)}/commit/${b.commit}`, b.commit.slice(0, 10)) : esc(b.commit.slice(0, 10))) : '';
  const kinds = (k) => snap.surfaces.filter((s) => s.kind === k);
  const msgs = kinds('message');
  const filters = '<form class="mapfilters" aria-label="Filter the map">'
    + `<fieldset><legend>Areas</legend>${areas.map((a) => `<label class="fchip"><input type="checkbox" id="f-a${areaIds.get(a)}" checked><span>${esc(a)}</span></label>`).join('')}</fieldset>`
    + '<fieldset><legend>Links</legend>'
    + ['all', '3', '10'].map((w) => `<label class="fchip"><input type="radio" name="w" id="f-w${w}"${w === 'all' ? ' checked' : ''}><span>${w === 'all' ? 'All' : `${w}+ imports`}</span></label>`).join('') + '</fieldset>'
    + '<fieldset><legend>Show</legend><label class="fchip"><input type="checkbox" id="f-tests" checked><span>Tests</span></label><label class="fchip"><input type="checkbox" id="f-cycles"><span>Cycles</span></label></fieldset></form>';
  const body = [
    styles(gr, areaIds),
    `<a class="back" href="${esc(ctx.home)}">← ${esc(run)} dashboard</a>`,
    blk('map-head', `<header class="run"><h1>Project map · ${esc(b.root ?? 'project')}</h1>${b.partial ? chip('partial', 'fail') : ''}`
      + `<span class="meta">build ${b.n ?? 0}${b.at ? ` · ${esc(b.at.slice(0, 16).replace('T', ' '))} UTC` : ''}${commit ? ` · commit ${commit}` : ''}${b.unit ? ` · after ${esc(b.unit)}` : ''} · ${b.scanned ?? 0} files scanned in ${((b.ms?.total ?? 0) / 1000).toFixed(1)} s</span></header>`
      + `<p class="say">${snap.modules.length} modules, ${snap.helpers.length} shared helpers, ${snap.settings.length} settings, ${kinds('route').length} routes, ${kinds('screen').length} screens, ${msgs.length} message keys in use or missing a locale, ${snap.reuse.length} reuse candidates.</p>`),
    '<h2>Imports</h2>',
    blk('map-graph', `${filters}<p class="meta">${gr.level === 'file' ? 'One box per file' : 'One box per folder'}; arrows point from the importer to what it imports, dashed ones close a cycle (shown with Cycles, or on hover), a green dot marks routes or screens. Hover a box to light its links; click it to open it on GitHub.</p>`
      + `<div class="mapbox">${svg(snap, gr, areaIds)}</div>`),
    '<h2>Surfaces</h2>',
    blk('map-routes', toggle('map-routes', `Routes · ${kinds('route').length}`, rows(kinds('route'), (s) => [`<code>${esc(s.method)} ${esc(s.path)}</code>`, fileLink(snap, s.file, s.line), few(s.services.map((f) => fileLink(snap, f)))], ['Route', 'Declared in', 'Behind it'], (s) => rowArea(s.file)))),
    blk('map-screens', toggle('map-screens', `Screens · ${kinds('screen').length}`, rows(kinds('screen'), (s) => [`<code>${esc(s.path)}</code>`, fileLink(snap, s.file), (s.calls ?? []).map((c) => `<code>${esc(c.split(' ').slice(0, 2).join(' ').replace(/^route:/, ''))}</code>`).join('<br>') || '<span class="meta">no calls found</span>'], ['Screen', 'File', 'Routes it calls'], (s) => rowArea(s.file)))),
    blk('map-messages', `<p class="meta">${b.messages?.keys ?? 0} message keys in ${(b.messages?.catalogs ?? []).length} catalog folders (${esc((b.messages?.catalogs ?? []).join('; '))}); ${b.messages?.unused ?? 0} not found in code${b.messages?.unknownLookups ? `; ${b.messages.unknownLookups} lookups match no key` : ''}${msgs.some((m) => m.missing) ? `; ${msgs.filter((m) => m.missing).length} keys miss a locale` : ''}. Keys built at runtime are not counted.</p>`),
    '<h2>Settings</h2>',
    blk('map-settings', toggle('map-settings', `Env vars and settings keys · ${snap.settings.length}`, rows([...snap.settings].sort((x, y) => y.writes.length - x.writes.length || y.reads.length - x.reads.length), (s) => [`<code>${esc(s.id)}</code>`,
      s.reads.slice(0, 4).map((r) => refLink(snap, r)).join('<br>') + (s.reads.length > 4 ? `<br><span class="meta">+${s.reads.length - 4}</span>` : ''),
      s.writes.slice(0, 4).map((r) => refLink(snap, r)).join('<br>') + (s.writes.length > 4 ? `<br><span class="meta">+${s.writes.length - 4}</span>` : '') + (s.declared ? `<br><span class="meta">declared in ${esc(s.declared.join(', '))}</span>` : '')], ['Key', 'Read at', 'Written at']))),
    '<h2>Shared helpers</h2>',
    blk('map-helpers', toggle('map-helpers', `Used by two or more files · ${snap.helpers.length}`, rows([...snap.helpers].sort((x, y) => y.usedBy.length - x.usedBy.length), (h) => [`<code>${esc(h.name)}</code>`, fileLink(snap, h.file, h.line), `${h.usedBy.length}`], ['Helper', 'Defined in', 'Used by'], (h) => rowArea(h.file)))),
    '<h2>Reuse candidates</h2>',
    blk('map-reuse', toggle('map-reuse', `Functions with the same shape · ${snap.reuse.length}`, rows(snap.reuse, (r) => [`${r.lines}`, r.fns.map((f) => { const [file, rest] = f.split('#'); const [name, line] = rest.split(':'); return `${fileLink(snap, file, Number(line), `${file}#${name}`)}`; }).join('<br>')], ['Lines', 'Where']))),
  ].join('\n');
  return page({ title: `Map · ${run}`, body, ctx, path: `${ctx.base ?? ''}/map` });
}
