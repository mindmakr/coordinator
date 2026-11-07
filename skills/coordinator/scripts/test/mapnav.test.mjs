import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hud, staticCtx } from '../lib/hud.mjs';
import { mapPage } from '../lib/map/page.mjs';
import { navGraph } from '../lib/mapnav.mjs';
import { mapsPage } from '../lib/mapspage.mjs';
import { flowSvg, ports, relevanceSvg } from '../lib/mapsvg.mjs';
import { cssText } from '../lib/parts.mjs';
import { selfPage } from '../lib/selfpage.mjs';
import { unitPage } from '../lib/unitpage.mjs';
import { decide } from '../lib/rules.mjs';
import { view } from '../lib/view.mjs';

const T0 = Date.parse('2026-11-06T06:00:00Z');
const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
function unit(id, o = {}) {
  return { id, title: null, bar: 'b', status: 'open', dot: 'waiting', after: null, link: null, links: [], behaviours: [], evidenceItems: [], timeline: [], asks: [], personNotes: [], roundList: [], rounds: 0, maxRounds: 3, scores: [], gap: null, cause: null, files: null, sentence: '', next: '', ...o };
}
const viewOf = (units, o = {}) => ({ id: 'r', goal: 'g', repo: 'acme/web', started: '2026-11-06T06:00:00Z', open: true, closedAt: null, phase: 'continue', goalCheck: { behaviours: [], evidence: [], met: false }, followUpNotes: [], units, ...o });
const issue = (n) => ({ url: `https://github.com/acme/web/issues/${n}` });
// c10 ← c11 ← c12 ← c14 (each waits on the one before); c11 links issue 5; one follow-up from c12.
const chain = () => viewOf([unit('c10'), unit('c11', { after: 'c10', links: [issue(5)] }), unit('c12', { after: 'c11' }), unit('c14', { after: 'c12' })],
  { followUpNotes: [{ unit: 'c12', text: 'tidy the copy' }] });
const classOf = (svg, attr) => new RegExp(`<a [^>]*class="([^"]*)" [^>]*data-node="${attr}"`).exec(svg)[1].split(' ');
const nIndex = (cls) => cls.find((c) => /^n\d+$/.test(c));

test('flow: hovering a box lights it and its direct children only, never its parent or grandchildren', () => {
  const svg = flowSvg(chain(), staticCtx('', 0), T0);
  const j = nIndex(classOf(svg, 'u:c11')).slice(1);
  assert.match(svg, new RegExp(`svg\\.map\\.flow:has\\(\\.n${j}:is\\(:hover,:focus-visible\\)\\) :is\\(\\.n${j},\\.k${j},\\.o${j}\\)\\{opacity:1\\}`));
  assert.ok(classOf(svg, 'u:c12').includes(`k${j}`), 'c12 waits on c11: its child');
  assert.ok(classOf(svg, 'r:acme/web#5').includes(`k${j}`), 'the issue c11 links: its child');
  assert.ok(!classOf(svg, 'u:c14').includes(`k${j}`), 'c14 is a grandchild and dims');
  assert.ok(!classOf(svg, 'u:c10').includes(`k${j}`), 'c10 is the parent and dims');
  assert.ok(!classOf(svg, 'u:c11').some((c) => /^c\d+$/.test(c)), 'no both-ways neighbour classes on this map');
  assert.match(svg, /<g class="eg hl ed\d+ o\d+" tabindex="0" role="img" aria-label="c11 links Issue #5"/);
  assert.match(svg, /aria-label="c12 filed follow-up 1"/);
});

test('flow and relevance: hovering or focusing a line lights the line and its two ends', () => {
  const svg = flowSvg(chain(), staticCtx('', 0), T0);
  const m = /<g class="eg hl ed(\d+) o\d+"[^>]*aria-label="c12 waits on c11[^"]*"/.exec(svg)[1];
  assert.match(svg, new RegExp(`svg\\.map\\.flow:has\\(\\.ed${m}:is\\(:hover,:focus-visible\\)\\) :is\\(\\.ed${m},\\.y${m}\\)\\{opacity:1\\}`));
  for (const k of ['u:c11', 'u:c12']) assert.ok(classOf(svg, k).includes(`y${m}`), `${k} is an end`);
  assert.ok(!classOf(svg, 'u:c14').includes(`y${m}`));
  assert.ok(svg.indexOf(`<path class="hit ed${m}" data-edge="${m}" data-from="u:c11" data-to="u:c12" d="M`) > svg.indexOf('<g class="hits">'), 'a wide pointer target along the line');
  assert.match(svg, new RegExp(`<path class="hit thin ed${m}" data-edge="${m}"`), 'and a narrow one over all the wide ones');
  assert.ok(svg.lastIndexOf('class="hit') < svg.indexOf('<g class="edges">'), 'pointer targets sit under the drawn lines and every box');
  assert.match(svg, /<path class="edge after crit" marker-start="url\(#flow-arrow-crit\)"/);
  const v = viewOf([unit('a1', { title: 'export billing csv files nightly' }), unit('a2')], { goalCheck: { behaviours: [{ id: 'G1', text: 'export billing csv files', status: 'unchecked' }], evidence: [], met: false } });
  const rel = relevanceSvg(v, staticCtx('', 0));
  assert.match(rel, /aria-label="a1 serves G1 \(shared words\)" data-edge="0" data-from="t:G1" data-to="u:a1"/);
  const t = nIndex(classOf(rel, 't:G1')).slice(1);
  assert.ok(classOf(rel, 'u:a1').includes(`k${t}`), 'a goal behaviour\'s children are the units serving it');
  assert.ok(!classOf(rel, 'u:a2').includes(`k${t}`), 'an off-goal unit is not');
  assert.match(rel, /data-nav="rel"/);
});

test('flow: each line end is its own shape, named in the legend; relevance says it has none', () => {
  const svg = flowSvg(chain(), staticCtx('', 0), T0);
  for (const id of ['flow-arrow-after', 'flow-arrow-crit', 'flow-arrow-link', 'flow-arrow-fu']) assert.match(svg, new RegExp(`<marker id="${id}"`));
  assert.match(svg, /<marker id="flow-arrow-link"[^>]*><circle class="arrow link"/, 'a ring at the issue end');
  assert.match(svg, /<marker id="flow-arrow-fu"[^>]*><path class="arrow fu" d="M1 1 9 5 1 9"\/>/, 'an open arrowhead at a follow-up');
  assert.match(svg, /marker-end="url\(#flow-arrow-link\)"/);
  assert.match(svg, /marker-end="url\(#flow-arrow-fu\)"/);
  for (const words of ['waits on: the arrow points to the unit it waits for', 'links an issue or PR: a ring at the issue end', 'filed a follow-up: an open arrowhead at the follow-up', 'on the critical path']) assert.ok(svg.includes(words), words);
  assert.match(svg, /<svg class="lsw"[^>]*aria-hidden="true"><path class="edge link"[^>]*\/><circle class="arrow link"/, 'the legend draws each end');
  assert.match(svg, /<p class="map-legend counts"><span><b>4<\/b> units<\/span><span><b>1<\/b> issues and PRs<\/span><span><b>1<\/b> follow-up<\/span><span><b>3<\/b> waits on<\/span><span><b>5<\/b> lines<\/span>/);
  const rel = relevanceSvg(chain(), staticCtx('', 0));
  assert.ok(rel.includes('No arrowheads here'));
  assert.doesNotMatch(rel, /marker-/);
});

test('walkable maps: keys and names are escaped; the snapshot has no script and no live controls', () => {
  const g = navGraph(['u:a', `u:${HOSTILE}`], [{ from: 'u:a', to: `u:${HOSTILE}` }]);
  const node = g.node(`u:${HOSTILE}`);
  assert.ok(!node.includes('<script') && node.includes('data-node="u:&lt;script&gt;'), node);
  const e = g.edge(0, { from: 'u:a', to: `u:${HOSTILE}` }, HOSTILE, '');
  assert.ok(!e.includes('<img') && !e.includes('<script'));
  assert.equal(g.rules('flow').includes('<'), false, 'rules are built from indexes only');
  const v = chain(); v.followUpNotes = [{ unit: 'c12', text: HOSTILE }]; v.units[0].title = HOSTILE;
  const html = mapsPage(v, T0);
  assert.ok(!html.includes('<script') && !html.includes('<img src=x'));
  assert.doesNotMatch(html, /data-nav-tools=|data-print[ >]/, 'search, focus and the button need the live script');
  assert.match(html, /Hover or focus a box to light it and its direct children/);
});

test('live maps page: search, focus and selection panel per walkable map, the walking script, the help', () => {
  const html = mapsPage(chain(), T0, { token: 't', nonce: 'n' });
  assert.equal((html.match(/data-nav-tools="(flow|rel)"/g) ?? []).length, 2);
  assert.match(html, /<input type="search" data-nav-find/);
  assert.match(html, /<input type="checkbox" data-nav-focus>/);
  assert.match(html, /data-nav-panel role="region" aria-label="Selected on this map" aria-live="polite" hidden/);
  assert.match(html, /Click, tap, Enter or Space selects a box/);
  assert.match(html, /Right-click, long-press or the Menu key opens a menu/);
  assert.ok(html.includes("'Open in new tab'") && html.includes('Select children') && html.includes("'Copy link'"), 'the menu items');
  assert.ok(html.includes("document.dispatchEvent(new CustomEvent('coordinator:patched'))"), 'the live patch tells the maps');
  assert.ok(html.includes("addEventListener('coordinator:patched'"), 'and they put the selection and pin back');
  assert.match(html, /#sel=/, 'the selection goes in the URL hash');
  assert.match(html, /sessionStorage/);
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'one nonce script');
});

test('Export PDF: a button on every live page, a hint on every snapshot, and print styles in both', () => {
  const s = { id: 'r1', tag: 'code', goal: 'fix totals', bar: 'b', fence: '', paths: [], budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
    createdAt: '2026-11-06T06:00:00Z', frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null, notes: [],
    units: [{ id: 'c10', bar: 'b', after: null, status: 'open', strategyChanges: 0, strategyAt: -1, rounds: [] }, { id: 'c11', bar: 'b', after: 'c10', status: 'open', strategyChanges: 0, strategyAt: -1, rounds: [] }] };
  const v = view(s, decide(s, T0), T0);
  const live = { token: 't', nonce: 'n' };
  const snap = { modules: [{ id: 'src/a.js', imports: [] }], helpers: [], settings: [], surfaces: [], reuse: [], build: {} };
  const pages = {
    hud: [hud(v, T0, live), hud(v, T0)],
    maps: [mapsPage(v, T0, live), mapsPage(v, T0)],
    unit: [unitPage(v, 'c11', T0, live), unitPage(v, 'c11', T0)],
    map: [mapPage(snap, { ...staticCtx('', 0), live: { token: 't', nonce: 'n' } }, 'r'), mapPage(snap, staticCtx('', 0), 'r')],
  };
  for (const [name, [on, off]] of Object.entries(pages)) {
    assert.match(on, /<button type="button" class="print-btn" data-print[^>]*>Export PDF<\/button>/, `${name}: button`);
    assert.match(off, /class="print-hint"[^>]*>Export PDF: Ctrl\+P or ⌘P, then Save as PDF/, `${name}: hint`);
    for (const html of [on, off]) {
      assert.match(html, /@media print \{/, `${name}: print styles`);
      assert.match(html, /break-inside: avoid/);
      assert.match(html, /details::details-content \{ content-visibility: visible/, 'toggles print open');
      assert.match(html, /\.top \.tools, \.pages, \.tl-tools, \.nav-tools[^{]*\.tip[^{]*\{ display: none !important; \}/, 'live-only controls and panels hidden');
      assert.match(html, /svg\.map \{ max-width: 100%; width: auto; height: auto; max-height: 190mm; \}/, 'maps fit the page');
      assert.match(html, /@page\{size:auto;margin:[^@]*@top-left\{content:"[^"]*"[^}]*\}@bottom-right\{content:"Page " counter\(page\) " of " counter\(pages\)/, 'header and page numbers');
      assert.match(html, /@media print\{:root,:root:has\(#theme-dark:checked\),:root\[data-theme="dark"\]\{[^}]*--bg:#f6f6f3/, 'always light on paper');
      assert.ok(html.includes('<div class="print-head" aria-hidden="true"><span data-printed></span></div>'), 'the export time goes here');
    }
  }
  assert.ok(selfPage, 'the coordinator page uses the same shell');
  assert.doesNotMatch(pages.hud[1], /<script/);
});

test('the print header escapes the run name inside CSS and HTML', () => {
  const s = cssText(`a"}</style><script>x</script>·`);
  assert.equal(/[<>"}{;\\]/.test(s.slice(1, -1).replace(/\\[0-9a-f]+ /g, '')), false, s);
  assert.equal(s, '"a\\22 \\7d \\3c \\2f style\\3e \\3c script\\3e x\\3c \\2f script\\3e \\b7 "');
  const v = viewOf([unit('u1')], { id: `r${HOSTILE}` });
  const html = mapsPage(v, T0);
  assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x'));
});

test('lines from one box start apart, in the order of where they go, and inside the box', () => {
  const box = { a: { y: 0, h: 46 }, b: { y: 100, h: 46 }, c: { y: 0, h: 46 }, d: { y: 200, h: 46 } };
  const list = [{ from: 'a', to: 'd' }, { from: 'a', to: 'b' }, { from: 'a', to: 'c' }];
  const port = ports(list, (k) => box[k]);
  const starts = list.map((_, m) => port(m)[0]);
  assert.equal(new Set(starts).size, 3, 'no two share a start');
  assert.ok(starts[2] < starts[1] && starts[1] < starts[0], 'ordered by target');
  assert.ok(starts.every((y) => y > 0 && y < 46));
  assert.equal(port(1)[1], 123, 'a single line ends at the middle');
});
