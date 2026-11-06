import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticCtx } from '../lib/hud.mjs';
import { mapPage } from '../lib/map/page.mjs';
import { mapsPage } from '../lib/mapspage.mjs';
import { MARKS, unitTip } from '../lib/maptips.mjs';
import { flowSvg, mindSvg, relevanceSvg, ringRadius } from '../lib/mapsvg.mjs';

const T0 = Date.parse('2026-11-06T06:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

function unit(id, o = {}) {
  return { id, title: null, bar: 'b', status: 'open', dot: 'waiting', after: null, link: null, links: [], behaviours: [], evidenceItems: [], timeline: [], asks: [], rounds: 0, maxRounds: 3, scores: [], gap: null, cause: null, files: null, ...o };
}
const viewOf = (units, o = {}) => ({ id: 'r', goal: 'g', repo: 'acme/web', started: at(0), open: true, closedAt: null, phase: 'continue', goalCheck: { behaviours: [], evidence: [], met: false }, followUpNotes: [], units, ...o });

const units = () => [
  unit('u1', { title: 'Sign-in redesign with a long title that needs clipping', status: 'pass', dot: 'passed', rounds: 2, scores: [{ score: 6 }, { score: 9 }], files: 14,
    links: [{ url: 'https://github.com/acme/web/pull/7' }, { url: 'javascript:alert(3)' }], timeline: [{ at: at(0), label: 'start' }, { at: at(95), label: 'verdict pass' }] }),
  unit('u2', { title: HOSTILE, status: 'fail', dot: 'retrying', after: 'u1', rounds: 1, scores: [{ score: 4 }], gap: HOSTILE, cause: 'tests' }),
  unit('u3', { status: 'building', dot: 'working' }),
];

test('labels: every unit box carries a status mark and its id, with the title clipped by an ellipsis', () => {
  const html = mapsPage(viewOf(units()), T0);
  for (const [id, m] of [['u1', MARKS.pass], ['u2', MARKS.fail], ['u3', MARKS.building]]) assert.ok(html.includes(`>${m} ${id}`), `${id} labelled with ${m}`);
  assert.ok(html.includes('Sign-in redesign with…'), 'a long title is clipped with an ellipsis');
  assert.ok(html.includes('Sign-in redesign with a long title that needs clipping'), 'the full title is in the hover text');
  assert.match(html, /class="xs muted elabel[^"]*"[^>]*>waits on<\/text>/, 'the waits-on edge says so');
  assert.match(html, /marker-start="url\(#flow-arrow/, 'and points to the unit it waits for');
  assert.match(html, /<text[^>]*>linked by u1<\/text>/, 'an issue box names the unit that links it');
  assert.ok(html.includes('waits on: the arrow points'), 'the legend explains it');
  for (const s of Object.keys(MARKS)) assert.match(html, new RegExp(`${MARKS[s]}</b>${s}`), `legend names ${s}`);
});

test('panel: one non-modal dialog per unit, described by every box of that unit, with its stats', () => {
  const html = mapsPage(viewOf(units()), T0 + 200 * 60_000);
  assert.equal((html.match(/role="dialog"/g) ?? []).length, 3);
  assert.ok((html.match(/aria-describedby="tip-u0"/g) ?? []).length >= 3, 'mind, flow and relevance boxes point at the panel');
  const tip = unitTip(units()[0], 0, staticCtx('', 0), T0 + 200 * 60_000);
  assert.match(tip, /<dt>Round<\/dt><dd>2\/3<\/dd>/);
  assert.match(tip, /<dt>Scores<\/dt><dd>6 → 9<\/dd>/);
  assert.match(tip, /<dt>Time<\/dt><dd>1 h 35 min<\/dd>/);
  assert.match(tip, /<dt>Files<\/dt><dd>14 files touched<\/dd>/);
  assert.match(tip, /href="https:\/\/github.com\/acme\/web\/pull\/7" target="_blank" rel="noopener noreferrer">PR acme\/web#7/);
  assert.ok(!tip.includes('javascript:'), 'only http(s) links');
  assert.match(tip, /href="units\/u1.html">Open u1/);
  assert.match(html, /body:not\(\[data-tips=off\]\):has\(\.u0:is\(:hover,:focus\)\) #tip-u0\{visibility:visible;transition-delay:0s\}/, 'CSS shows it on hover and focus');
  assert.match(html, /svg\.map:has\(\.u1:is\(:hover,:focus\)\) :is\(\.u1,\.c1,\.e1\)[^{]*\{opacity:1\}/, 'and lights what it connects to');
  assert.match(html, /class="edge after [^"]*\be0\b[^"]*\be1\b/, 'the waits-on edge lights with either end');
});

test('hostile titles and gaps are escaped in labels, hover text and panels', () => {
  const html = mapsPage(viewOf(units()), T0);
  assert.ok(!html.includes('<script>alert'), 'no raw script');
  assert.ok(!html.includes('<img src=x'), 'no raw tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img'), 'escaped in the panel');
  assert.ok(!/javascript:/.test(html), 'no javascript: link anywhere');
});

test('mind map: the unit ring grows so neighbouring boxes never overlap', () => {
  for (const n of [2, 5, 12, 30]) {
    const r = ringRadius(n, 150);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; const b = a + (2 * Math.PI) / n;
      const dx = Math.abs(r * (Math.cos(b) - Math.cos(a))); const dy = Math.abs(r * (Math.sin(b) - Math.sin(a)));
      assert.ok(dx >= 140 + 12 - 1e-6 || dy >= 42 + 12 - 1e-6, `${n} units: boxes ${i} and ${i + 1} clear`);
    }
  }
  const svg = mindSvg(viewOf(Array.from({ length: 20 }, (_, i) => unit(`unit-${i}`))), staticCtx('', 0));
  assert.equal((svg.match(/class="u u\d+ hl"/g) ?? []).length, 20);
});

test('project map: each module has a panel with its files and helpers; names escaped', () => {
  const snap = {
    modules: [{ id: 'src/a.js', imports: ['src/b.js'] }, { id: 'src/b.js', imports: [] }],
    helpers: [{ name: HOSTILE, file: 'src/b.js', line: 1, usedBy: ['src/a.js', 'x.js'] }],
    settings: [], surfaces: [], reuse: [], build: {},
  };
  const html = mapPage(snap, staticCtx('', 0), 'r');
  assert.equal((html.match(/role="dialog"/g) ?? []).length, 2);
  assert.match(html, /aria-describedby="tip-n\d"/);
  assert.match(html, /<dt>Helpers \(1\)<\/dt>/);
  assert.match(html, /<dt>File<\/dt><dd><code>src\/b\.js<\/code>/);
  assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x'), 'helper names escaped');
  assert.match(html, /class="n [^"]*\bc1\b[^"]*" id="n0"|class="n [^"]*\bc0\b[^"]*" id="n1"/, 'linked modules carry each other\'s class');
});

test('hovering a unit keeps the units it connects to lit: waits on both ways, and shared links in the mind map', () => {
  const chain = viewOf([unit('c10'), unit('c11', { after: 'c10' }), unit('c12', { after: 'c11' }), unit('c14', { after: 'c12' }),
    unit('c19', { links: [{ url: 'https://github.com/acme/web/issues/5' }] }), unit('c20', { links: [{ url: 'https://github.com/acme/web/issues/5' }] })]);
  const flow = flowSvg(chain, staticCtx('', 0), T0);
  const boxClass = (svg, id) => new RegExp(`<a href="units/${id}\.html"[^>]* class="([^"]*)"`).exec(svg)[1].split(' ');
  assert.ok(boxClass(flow, 'c11').includes('c2'), 'c11 (waited on by c12) carries c12\'s class');
  assert.ok(boxClass(flow, 'c14').includes('c2'), 'c14 (waits on c12) carries c12\'s class');
  assert.ok(!boxClass(flow, 'c10').includes('c2'), 'c10 is two steps away and dims');
  const html = mapsPage(chain, T0);
  assert.match(html, /svg\.map:has\(\.u2:is\(:hover,:focus\)\) :is\(\.u2,\.c2,\.e2\)/, 'the rule that lights c2 elements when c12 is hovered');
  const mind = mindSvg(chain, staticCtx('', 0));
  assert.ok(boxClass(mind, 'c20').includes('c4'), 'c20 shares issue 5 with c19');
  assert.match(html, /body:has\(#tip-u2:focus-within\) svg\.map :is\(\.u2,\.c2,\.e2\)/, 'lit while focus is inside the panel');
});

test('goal relevance: with no unit on goal, the Off goal heading sits below Units', () => {
  const v = viewOf([unit('x1', { title: 'unrelated' })], { goal: 'ship the billing export' });
  const svg = relevanceSvg(v, staticCtx('', 0));
  const y = (label) => Number(new RegExp(`<text x="[^"]+" y="([^"]+)"[^>]*>${label}</text>`).exec(svg)[1]);
  assert.ok(y('Off goal') - y('Units') >= 20, 'headings do not overlap');
  const boxY = Number(/<rect class="nd [^"]*off" x="[^"]+" y="([^"]+)"/.exec(svg)[1]);
  assert.ok(boxY > y('Off goal'), 'the off-goal box sits under its heading');
});
