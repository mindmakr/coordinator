import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrollDelta } from '../lib/anchor.mjs';
import { scoreChart } from '../lib/hud.mjs';
import { findMatches, highlight, unhighlight } from '../lib/highlight.mjs';
import { morph } from '../lib/morph.mjs';
import { DOTS, dotState } from '../lib/plain.mjs';

// Just enough DOM for morph: elements, text, attributes, child lists.
class Node {
  constructor(type, tag, value) { this.nodeType = type; this.tagName = tag; this.nodeValue = value; this.childNodes = []; this.attrs = new Map(); this.parentNode = null; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); c.parentNode = this; return c;
  }
  get text() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.text).join(''); }
}
const h = (tag, attrs = {}, ...kids) => {
  const n = new Node(1, tag.toUpperCase());
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.insertBefore(typeof k === 'string' ? new Node(3, null, k) : k, null);
  return n;
};
const frag = (...kids) => h('#fragment', {}, ...kids);
const all = (n) => [n, ...n.childNodes.flatMap(all)];
const hooks = (extra = {}) => ({ busy: () => false, skipped: () => {}, added: () => {}, ...extra });

const decisions = (n) => h('ul', {}, ...Array.from({ length: n }, (_, i) => h('li', { 'data-a': `l-d${i + 1}` }, `Decision ${i + 1}`)));
const lists = (n) => h('div', { 'data-k': 'lists', 'data-h': `h${n}` }, h('section', { 'data-a': 'list-Decisions' }, h('h3', {}, `Decisions ${n}`), decisions(n)));

test('appending to a long list keeps every row node, so the reader at Decision 24 does not move', () => {
  const app = frag(h('h2', { 'data-a': 'h-Decisions' }, 'Decisions'), lists(45));
  const before = all(app);
  const reader = before.find((n) => n.text === 'Decision 24' && n.tagName === 'LI');
  const added = [];
  morph(app, frag(h('h2', { 'data-a': 'h-Decisions' }, 'Decisions'), lists(48)), hooks({ added: (n) => added.push(n) }));
  const after = all(app);
  assert.ok(before.every((n) => n.tagName === '#FRAGMENT' || after.includes(n)), 'no node was replaced');
  assert.ok(after.includes(reader), 'the reader\'s row is the same node');
  assert.deepEqual(added.map((n) => n.text), ['Decision 46', 'Decision 47', 'Decision 48']);
  assert.equal(app.text.includes('Decisions 48'), true, 'changed text is updated in place');
  // The browser keeps a kept node where it was; where it cannot, the keyed fallback asks for no jump.
  assert.equal(scrollDelta({ key: 'a:l-d24', top: 300 }, [{ key: 'a:l-d24', top: 300 }]), 0);
});

test('rows inserted above the reader (the timeline, newest first) are added; the rest stay put', () => {
  const tl = (keys) => h('ol', { 'data-k': 'timeline', 'data-h': keys.join() }, ...keys.map((k) => h('li', { 'data-a': k, 'data-at': k }, k)));
  const app = frag(tl(['e3', 'e2', 'e1']));
  const old = all(app).filter((n) => n.tagName === 'LI');
  old[1].setAttribute('hidden', ''); // the filter hid e2
  morph(app, frag(tl(['e6', 'e5', 'e4', 'e3', 'e2', 'e1'])), hooks());
  const rows = app.childNodes[0].childNodes;
  assert.deepEqual(rows.map((r) => r.getAttribute('data-a')), ['e6', 'e5', 'e4', 'e3', 'e2', 'e1']);
  assert.deepEqual(rows.slice(3), old, 'the three old rows are the same nodes, in order');
  assert.equal(old[1].hasAttribute('hidden'), true, 'with a filter active, a hidden row stays hidden until the filter runs again');
});

test('a tall card that grows keeps its content nodes and the reader\'s open toggle', () => {
  const card = (n, say) => h('section', { 'data-k': 'unit-u1', 'data-h': `c${n}` },
    h('p', { class: 'say' }, say),
    h('details', { 'data-d': 'u-u1-beh', 'data-a': 'd-u-u1-beh' }, h('summary', {}, `Behaviours ${n}`),
      h('ul', {}, ...Array.from({ length: n }, (_, i) => h('li', { 'data-a': `b-B${i + 1}` }, `B${i + 1}`)))),
    h('p', { class: 'next' }, 'Next: build'));
  const app = frag(card(20, 'try 2'));
  const details = app.childNodes[0].childNodes[1];
  details.setAttribute('open', ''); // the reader opened it
  const before = all(app);
  morph(app, frag(card(22, 'try 3')), hooks());
  assert.ok(before.every((n) => n.tagName === '#FRAGMENT' || all(app).includes(n)), 'nothing replaced');
  assert.equal(details.hasAttribute('open'), true);
  assert.equal(details.childNodes[1].childNodes.length, 22);
  assert.equal(app.childNodes[0].childNodes[0].text, 'try 3');
});

test('a form being filled in is left alone, and the page hears so', () => {
  const form = (v) => h('form', { class: 'note' }, h('textarea', { name: 'text' }, v));
  const app = frag(h('div', { 'data-k': 'note', 'data-h': '1' }, form('')));
  const f = app.childNodes[0].childNodes[0];
  let skipped = 0;
  morph(app, frag(h('div', { 'data-k': 'note', 'data-h': '2' }, form('server'))), hooks({ busy: (x) => x === f, skipped: () => { skipped++; } }));
  assert.equal(app.childNodes[0].childNodes[0], f); assert.equal(f.text, ''); assert.equal(skipped, 1);
});

test('unit status dots: working, waiting, retrying, stale, passed, stopped', () => {
  const u = (status, rounds = []) => ({ status, rounds });
  const fail = { verdict: 'fail' };
  const cases = [
    [u('building'), { action: 'wait' }, 'working'], [u('judging'), { action: 'judge' }, 'working'],
    [u('open'), { action: 'wait', reason: 'after a' }, 'waiting'], [u('open'), { action: 'build' }, 'waiting'],
    [u('open', [fail, fail]), { action: 'build' }, 'retrying'], [u('building', [fail, fail]), { action: 'wait' }, 'retrying'],
    [u('building'), { action: 'check-stale', phase: 'building' }, 'stale'],
    [u('pass', [{ verdict: 'pass' }]), { action: 'done' }, 'passed'],
    [u('stopped'), { action: 'stopped' }, 'stopped'], [u('open', [fail]), { action: 'stop', reason: 'budget: time' }, 'stopped'],
  ];
  for (const [unit, d, want] of cases) assert.equal(dotState(unit, d), want, `${unit.status} ${d.action}`);
  assert.deepEqual(Object.keys(DOTS).sort(), ['passed', 'retrying', 'stale', 'stopped', 'waiting', 'working']);
});

test('each score dot says its try, result and score; one try reads as words', () => {
  const rounds = [
    { n: 1, verdict: 'fail', score: 5, cause: 'stale settings read outside the transaction', gap: 'g' },
    { n: 2, verdict: 'fail', score: 8, cause: null, gap: 'rounding <b>' },
    { n: 3, verdict: 'pass', score: 9.5 },
  ];
  const html = scoreChart(rounds);
  assert.match(html, /Score per try \(0–10\)/);
  assert.match(html, /<circle class="f"[^>]*tabindex="0" role="img" aria-label="Try 1: failed, 5\/10 — stale settings read outside the transaction"><title>Try 1: failed, 5\/10 — stale settings read outside the transaction<\/title><\/circle>/);
  assert.match(html, /<title>Try 2: failed, 8\/10 — rounding &lt;b&gt;<\/title>/);
  assert.match(html, /<title>Try 3: passed, 9\.5\/10<\/title>/);
  assert.match(html, /last 9\.5\/10/);
  assert.doesNotMatch(html, /<line /, 'no meaningless baseline');
  assert.equal((html.match(/<title>/g) ?? []).length, 3);
  assert.equal(scoreChart([{ n: 1, verdict: 'pass', score: 9 }]), '<p class="cause score-one">Passed on try 1 (9/10)</p>');
  assert.equal(scoreChart([]), '');
});

const doc = { createElement: (t) => new Node(1, t.toUpperCase()), createTextNode: (v) => new Node(3, null, v) };
Node.prototype.appendChild = function appendChild(c) { return this.insertBefore(c, null); };
const marks = (n) => all(n).filter((x) => x.tagName === 'MARK');
const row = (key, text) => h('li', { 'data-a': key, 'data-at': key }, h('time', { datetime: key }, 'now'), h('span', {}, h('b', {}, 'u1 '), text));

test('search highlights: text nodes only, so an injected term is highlighted as text', () => {
  const r = row('e1', 'refused <img src=x onerror=alert(1)> at the gate');
  const n = highlight([r], '<IMG SRC=X ONERROR', doc);
  assert.equal(n, 1);
  const [m] = marks(r);
  assert.equal(m.text, '<img src=x onerror');
  assert.equal(all(r).some((x) => x.tagName === 'IMG'), false, 'no element was made from the text');
  assert.equal(r.text, 'nowu1 refused <img src=x onerror=alert(1)> at the gate', 'the text reads the same');
  unhighlight(r);
  assert.equal(marks(r).length, 0);
  assert.equal(r.childNodes[1].childNodes.length, 2, 'cleared back to one text node');
});

test('search highlights: case, accents and Arabic/Urdu diacritics; never inside <time>', () => {
  assert.deepEqual(findMatches('Café CAFE cafe', 'cafe'), [[0, 4], [5, 9], [10, 14]]);
  assert.deepEqual(findMatches('مُحَمَّد دفع', 'محمد'), [[0, 8]], 'harakat are ignored, and kept inside the match');
  assert.deepEqual(findMatches('ادائیگی ہو گئی', 'ادائیگی'), [[0, 7]]);
  assert.deepEqual(findMatches('anything', '  '), []);
  const r = row('e2', 'now and now');
  assert.equal(highlight([r], 'now', doc), 2, 'the <time> text is not searched');
});

test('search highlights come back after a live patch, on the same row node', () => {
  const tl = (...rows) => h('ol', { 'data-k': 'timeline', 'data-h': rows.length }, ...rows);
  const app = frag(tl(row('e1', 'totals off by one')));
  const kept = app.childNodes[0].childNodes[0];
  highlight([kept], 'totals', doc);
  assert.equal(marks(app).length, 1);
  // The page's patch: unhighlight, morph, then the filters (and highlights) again.
  unhighlight(app);
  morph(app, frag(tl(row('e2', 'new totals check'), row('e1', 'totals off by one'))), hooks());
  const n = highlight(app.childNodes[0].childNodes, 'totals', doc);
  assert.equal(n, 2);
  assert.equal(app.childNodes[0].childNodes[1], kept, 'the highlighted row is the same node');
  assert.equal(marks(kept)[0].text, 'totals');
});
