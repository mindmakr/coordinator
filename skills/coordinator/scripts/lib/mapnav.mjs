// Walking the Flow and Goal relevance maps one level at a time. Hovering or
// focusing a node lights it and its direct children (never grandchildren) and
// the lines between them; hovering or focusing a line lights it and its two
// ends. CSS does that (:has rules per node and line), so the static snapshot
// needs no script. The live page's script (mapnav.client.js) adds select,
// breadcrumb, children list, context menu, focus and search; it reads the graph
// from data-node, data-from and data-to. Keys and labels are escaped.
import { esc } from './links.mjs';

// keys: every node's key in drawing order; edges: [{ from, to }] by key.
export function navGraph(keys, edges) {
  const hits = [];
  const ix = new Map(keys.map((k, j) => [k, j]));
  const extra = new Map(keys.map((k) => [k, []]));
  edges.forEach((e, m) => {
    const a = ix.get(e.from); const b = ix.get(e.to);
    if (a === undefined || b === undefined) return;
    extra.get(e.to).push(`k${a}`); // a child of a: lit with a
    extra.get(e.from).push(`y${m}`); extra.get(e.to).push(`y${m}`); // an end of line m: lit with it
  });
  return {
    // Classes and data for a node; `cls` is the node's own (trusted) class list.
    node(key, cls = 'hl', more = '') {
      const j = ix.get(key);
      return ` class="${cls} nv n${j}${[...new Set(extra.get(key))].map((c) => ` ${c}`).join('')}" data-node="${esc(key)}"${more}`;
    },
    // A line: lit with its start node (o<j>), focusable, named for screen readers. Its pointer target is
    // drawn apart, in hitLayers(), under every box.
    edge(m, e, label, d, inner) {
      hits.push({ m, e, label, d });
      return `<g class="eg hl ed${m} o${ix.get(e.from)}" tabindex="0" role="img" aria-label="${esc(label)}" data-edge="${m}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><title>${esc(label)}</title>${inner}</g>`;
    },
    // Two layers of invisible strokes along each line's own path: wide ones, then narrow ones over all of
    // them, so a point on a line's centre reaches that line even where another's wide stroke covers it.
    hitLayers() {
      const layer = (cls) => `<g class="hits">${hits.map(({ m, e, label, d }) => `<path class="${cls} ed${m}" data-edge="${m}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}"><title>${esc(label)}</title></path>`).join('')}</g>`;
      return layer('hit') + layer('hit thin');
    },
    // The lighting class of line m (its start node), for a drawn copy of it.
    cls(m) { return `o${ix.get(edges[m].from)}`; },
    // Per node: itself, its children and its outgoing lines. Per line: itself and its ends. Keyboard focus
    // lights too; the focus a mouse click leaves behind does not (it would outlast the pointer).
    rules(map) {
      const s = `svg.map.${map}`;
      return keys.map((_, j) => `${s}:has(.n${j}:is(:hover,:focus-visible)) :is(.n${j},.k${j},.o${j}){opacity:1}`).join('')
        + edges.map((_, m) => `${s}:has(.ed${m}:is(:hover,:focus-visible)) :is(.ed${m},.y${m}){opacity:1}${s}:has(.hit.ed${m}:hover) .eg.ed${m} .edge{stroke-width:3}`).join('');
    },
  };
}

// The live toolbar above a walkable map: search, focus, and the selection panel the script fills.
export const navTools = (map, label) => `<div class="nav-tools" data-nav-tools="${esc(map)}">`
  + `<label class="nav-find">Find a ${esc(label)} <input type="search" data-nav-find autocomplete="off" placeholder="id or title"></label>`
  + '<label class="nav-focus"><input type="checkbox" data-nav-focus> Focus: hide what is not selected</label>'
  + '<span class="cause" data-nav-count aria-live="polite"></span>'
  + `<div class="nav-panel" data-nav-panel role="region" aria-label="Selected on this map" aria-live="polite" hidden></div></div>`;

// How to use it, said once under each walkable map.
export const navHelp = (live) => `<p class="map-legend nav-help"><span class="cause">${live
  ? 'Hover a box to light it and its direct children; hover a line to light its two ends. Click, tap, Enter or Space selects a box (again, or Escape, clears it); then → goes to its first child, ↑ ↓ to the next child, ← back up. Right-click, long-press or the Menu key opens a menu.'
  : 'Hover or focus a box to light it and its direct children; hover or focus a line to light its two ends.'}</span></p>`;
