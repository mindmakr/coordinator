// The shared components (lib/ui.mjs, re-exported by lib/parts.mjs), the page shell,
// the theme switch's memory (lib/theme.client.js) and the panels' memory (restoreOpen).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { bar, cols, heading, kpis, page, panel, rememberToggle, restoreOpen, table, toneChip, tries, typeOf, typeTag, TYPES } from '../lib/parts.mjs';
import { privacy } from '../lib/quality/privacy.mjs';
import { sourceFile } from '../lib/quality/source.mjs';

const BAD = '<img src=x onerror=alert(1)>"\'&';
const clean = (html) => { assert.doesNotMatch(html, /<img src=x|onerror=alert\(1\)>"/, 'the hostile text is escaped'); return html; };

test('heading: h1 and a muted line, escaped', () => {
  assert.equal(heading('r1', 'Goal text'), '<div class="head"><h1>r1</h1><span class="muted">Goal text</span></div>');
  assert.equal(heading('r1'), '<div class="head"><h1>r1</h1></div>');
  clean(heading(BAD, BAD));
});

test('kpis: label, value, small line and an optional bar per tile', () => {
  const html = kpis([{ k: 'Units', v: '1 of 6', bar: 17 }, { k: 'Tries', v: 9, s: '11 verdicts' }]);
  assert.equal(html, '<div class="kpis">'
    + '<div class="kpi"><span class="k">Units</span><span class="v">1 of 6</span><div class="bar" role="img" aria-label="17%"><span style="width:17%"></span></div></div>'
    + '<div class="kpi"><span class="k">Tries</span><span class="v">9</span><span class="s">11 verdicts</span></div></div>');
  clean(kpis([{ k: BAD, v: BAD, s: BAD }]));
});

test('cols: a main and a side column; no side, no empty column', () => {
  assert.equal(cols('<p>a</p>', '<p>b</p>'), '<div class="cols"><div class="main"><p>a</p></div><div class="side"><p>b</p></div></div>');
  assert.equal(cols('<p>a</p>'), '<div class="cols"><div class="main"><p>a</p></div></div>');
});

test('panel: details.panel with chevron, h2, count and controls in its summary, state kept by its id', () => {
  const html = panel({ id: 'units', title: 'Units', count: 6, metaHtml: '<button type="button" class="btn sm">Fit</button>', bodyHtml: '<p>x</p>' });
  assert.equal(html, '<details class="panel" data-d="units" data-a="panel-units" open>'
    + '<summary><span class="chev" aria-hidden="true">›</span><h2>Units</h2><span class="count">6</span><span class="meta"><button type="button" class="btn sm">Fit</button></span></summary>'
    + '<div class="body"><p>x</p></div></details>');
  assert.doesNotMatch(html, /<summary[^>]*tabindex/, 'the summary stays in the tab order: Enter and Space toggle it');
  const shut = panel({ id: 'tl', title: 'Timeline', bodyHtml: '', open: false, scroll: 360, flush: true, tone: 'ask' });
  assert.match(shut, /^<details class="panel ask" data-d="tl" data-a="panel-tl"><summary>/, 'closed: no open attribute; a tone class');
  assert.match(shut, /<div class="body scroll flush" style="max-height:360px">/, 'a scrolling body');
  assert.doesNotMatch(shut, /class="count"/, 'no count given, none shown');
  assert.equal(panel({ id: 'a', title: 'A', count: 0 }).includes('<span class="count">0</span>'), true, 'a zero count is shown');
  assert.doesNotMatch(panel({ id: 'a', title: 'A', scroll: '1px;background:url(x)' }), /url\(|style=/, 'only a plain length becomes a style');
  assert.doesNotMatch(panel({ id: 'a', title: 'A', tone: 'x" onclick="y' }), /onclick/, 'an unknown tone is dropped');
  clean(panel({ id: BAD, title: BAD, count: BAD }));
});

test('table: table.t with a sticky header row, inside its own scrolling box; cells escaped unless given as html', () => {
  const html = table({ cols: [{ label: 'Unit' }, { label: 'Age', num: true }], rows: [['u1', '12 min'], [{ html: '<a href="#u2">u2</a>' }, 3]], min: 720, max: '420px' });
  assert.equal(html, '<div class="scroll tbox" style="max-height:420px"><table class="t" style="min-width:720px">'
    + '<thead><tr><th scope="col">Unit</th><th scope="col" class="num">Age</th></tr></thead>'
    + '<tbody><tr><td>u1</td><td class="num">12 min</td></tr><tr><td><a href="#u2">u2</a></td><td class="num">3</td></tr></tbody></table></div>');
  assert.equal(table({ cols: [{ label: 'A' }], rows: [], empty: 'No units' }), '<p class="empty">No units</p>');
  clean(table({ cols: [{ label: BAD }], rows: [[BAD]] }));
  const tpl = readFileSync(new URL('../lib/hud.template.html', import.meta.url), 'utf8');
  assert.match(tpl, /\.t th \{[^}]*position: sticky; top: 0;/, 'the header row sticks');
});

test('toneChip: the status word is always shown; tone is colour on top of it', () => {
  for (const tone of ['ask', 'ok', 'retry', 'bad', 'done']) assert.equal(toneChip('Waiting on you', tone), `<span class="chip ${tone}">Waiting on you</span>`);
  assert.equal(toneChip('Queued'), '<span class="chip">Queued</span>');
  assert.equal(toneChip('', 'bad'), '', 'no word, no chip: never a colour alone');
  assert.equal(toneChip(null, 'ok'), '');
  assert.equal(toneChip('x', 'red"'), '<span class="chip">x</span>', 'an unknown tone is dropped');
  clean(toneChip(BAD, 'ok'));
});

test('typeTag: IMG, LOG, CSV, TXT, PDF, URL or TEST, by extension, then by kind; never empty', () => {
  assert.deepEqual(TYPES, ['IMG', 'LOG', 'CSV', 'TXT', 'PDF', 'URL', 'TEST']);
  const cases = [['screenshot', 'u1/E1-shot.png', 'IMG'], ['log', 'u1/E2.csv', 'CSV'], ['log', 'u1/E3.log', 'LOG'], ['log', undefined, 'LOG'], ['log', 'u1/E4.md', 'TXT'],
    ['pdf', 'a.PDF', 'PDF'], ['link', undefined, 'URL'], ['test', undefined, 'TEST'], ['reins', 'r.md', 'TXT'], ['prism', 'g.json', 'TXT'], ['what', undefined, 'TXT'], [undefined, undefined, 'TXT']];
  for (const [kind, file, want] of cases) assert.equal(typeOf(kind, file), want, `${kind} ${file}`);
  for (const [kind, file] of cases) assert.ok(TYPES.includes(typeOf(kind, file)));
  assert.equal(typeTag('test'), '<span class="tag" title="TEST">TEST</span>');
  clean(typeTag(BAD, BAD));
});

test('tries: one mark per try, in a glyph and in words', () => {
  const html = tries(['fail', 'fail', 'pass', 'work', 'queued', 'open']);
  assert.equal(html, '<span class="tries" role="img" aria-label="try 1 failed, try 2 failed, try 3 passed, try 4 in progress, try 5 queued, try 6 not used">'
    + '<span class="pip f" aria-hidden="true">✕</span><span class="pip f" aria-hidden="true">✕</span><span class="pip p" aria-hidden="true">✓</span>'
    + '<span class="pip j" aria-hidden="true">…</span><span class="pip q" aria-hidden="true">5</span><span class="pip o" aria-hidden="true"></span></span>');
  assert.match(tries(['nonsense']), /try 1 not used/);
});

test('bar: a meter clamped to 0-100 with its percent as its label', () => {
  assert.equal(bar(42.4), '<div class="bar" role="img" aria-label="42%"><span style="width:42%"></span></div>');
  assert.match(bar(150), /width:100%/); assert.match(bar(-3), /width:0%/); assert.match(bar('x'), /width:0%/);
  assert.equal(bar(50, { label: '3 of 6 done', tone: 'ok' }), '<div class="bar ok" role="img" aria-label="3 of 6 done"><span style="width:50%"></span></div>');
  assert.doesNotMatch(bar(5, { tone: 'x" y' }), /x" y/);
  clean(bar(5, { label: BAD }));
});

const ctx = (live = null, pages = []) => ({ live, theme: null, pages });
const PAGES = [{ path: '/', label: 'Overview', href: '/?t=a' }, { path: '/maps', label: 'Maps', href: '/maps?t=a' }];

test('page: the shell has a breadcrumb, tabs and the theme switch; crumbs escaped; static pages run no script', () => {
  const html = page({ title: 'r1', body: '<p>b</p>', ctx: ctx(null, PAGES), path: '/maps', crumbs: [{ label: 'This PC', href: '/' }, { label: 'proj' }, { label: 'r1' }], flag: toneChip('Waiting on you', 'ask') });
  assert.match(html, /<header class="top"><nav class="crumbs" aria-label="Breadcrumb"><svg class="mark"[\s\S]*?<\/svg><a href="\/">This PC<\/a><span class="sep" aria-hidden="true">\/<\/span><span>proj<\/span><span class="sep" aria-hidden="true">\/<\/span><span class="here" aria-current="location">r1<\/span><span class="chip ask">Waiting on you<\/span><\/nav>/);
  assert.match(html, /<nav class="tabs" aria-label="Pages"><a href="\/\?t=a">Overview<\/a><a href="\/maps\?t=a" aria-current="page">Maps<\/a><\/nav>/);
  assert.match(html, /<fieldset class="themes"><legend class="sr">Colour theme<\/legend><input type="radio" name="theme" id="theme-system" value="system" checked><label for="theme-system">System<\/label>/);
  assert.match(html, /<span class="live" data-state="snapshot">Snapshot · read-only<\/span>/, 'the hosted service strips this exact chip on settings pages');
  assert.doesNotMatch(html, /<script/, 'a static page runs no script: the switch works by CSS alone');
  assert.match(html, /:root:has\(#theme-dark:checked\),:root\[data-theme="dark"\]\{/);
  assert.match(html, /<\/header><nav class="tabs"[\s\S]*<div class="wrap">\n<main id="app"><p>b<\/p><\/main>/, 'the bars span the page; the content sits in the wrap');
  const plain = page({ title: BAD, body: '', ctx: ctx(), path: '/' });
  clean(plain);
  assert.match(plain, /<span class="here" aria-current="location">&lt;img/, 'no crumbs given: the title');
  assert.doesNotMatch(plain, /class="tabs"/, 'no pages, no tab row');
  const xss = page({ title: 't', body: '', ctx: ctx(), path: '/', crumbs: [{ label: BAD, href: 'javascript:x" onclick="y' }, { label: 't' }] });
  clean(xss); assert.doesNotMatch(xss, /href="javascript:x" onclick/);
});

test('page: a live page applies the stored theme from <head>, with the nonce, before the body', () => {
  const html = page({ title: 'r1', body: '', ctx: { ...ctx({ nonce: 'N1', token: 'T' }, PAGES), run: 'r1' }, path: '/' });
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<script nonce="N1">\/\/ The theme switch's memory[\s\S]*'coordinator\.theme'[\s\S]*<\/script>\n$/);
  assert.match(html, /script-src 'nonce-N1'/);
  assert.equal((html.match(/<script nonce="N1">/g) ?? []).length, 2);
  assert.match(html, /const restoreOpen = function restoreOpen/, 'the page runs restoreOpen from lib/ui.mjs');
  assert.match(html, /const openKey = key\(`open:\$\{path\}`\)/, 'panels are remembered per page');
  assert.equal((html.match(/coordinator:theme/g) ?? []).length, 1, 'the old theme key appears once, to be migrated');
});

// A fake page for theme.client.js: <html>, the three radios, localStorage.
function themePage({ stored = null, getThrows = false, setThrows = false, ready = 'loading' } = {}) {
  const writes = [];
  const listeners = {};
  const radios = ['system', 'light', 'dark'].map((value) => ({ value, checked: value === 'system', id: `theme-${value}`, on: {}, addEventListener(t, f) { this.on[t] = f; } }));
  const document = {
    readyState: ready, documentElement: { dataset: {} },
    getElementById: (id) => radios.find((r) => r.id === id) ?? null,
    querySelectorAll: (sel) => (sel === 'input[name="theme"]' ? radios : []),
    addEventListener: (t, f) => { listeners[t] = f; },
  };
  const localStorage = {
    getItem: (k) => { if (getThrows) throw new Error('SecurityError'); return k === 'coordinator.theme' ? stored : null; },
    setItem: (k, v) => { if (setThrows) throw new Error('QuotaExceededError'); writes.push([k, v]); },
  };
  const src = readFileSync(new URL('../lib/theme.client.js', import.meta.url), 'utf8');
  runInNewContext(src, { document, localStorage });
  return { root: document.documentElement, radios, writes, ready: () => listeners.DOMContentLoaded?.() };
}

test('theme.client.js: the stored choice applies before the first paint, the switch changes and stores it', () => {
  const p = themePage({ stored: 'dark' });
  assert.equal(p.root.dataset.theme, 'dark', 'set on <html> while the head runs, before the body exists');
  assert.equal(p.radios[2].checked, false, 'the radios are not parsed yet');
  p.ready();
  assert.equal(p.radios[2].checked, true, 'then its radio is checked');
  p.radios[1].on.change();
  assert.equal(p.root.dataset.theme, 'light');
  assert.deepEqual(p.writes, [['coordinator.theme', 'light']]);
  assert.equal(themePage({ stored: null }).root.dataset.theme, 'system', 'nothing stored: the system theme');
  assert.equal(themePage({ stored: '"><x' }).root.dataset.theme, 'system', 'an unknown value: the system theme');
  const parsed = themePage({ stored: 'light', ready: 'complete' });
  assert.equal(parsed.radios[1].checked, true, 'already parsed: bound at once');
});

test('theme.client.js: a choice kept under the old key is carried over once and the old key removed', () => {
  const mk = (store) => {
    const document = { readyState: 'complete', documentElement: { dataset: {} }, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };
    const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
    runInNewContext(readFileSync(new URL('../lib/theme.client.js', import.meta.url), 'utf8'), { document, localStorage });
    return document.documentElement.dataset.theme;
  };
  const a = { 'coordinator:theme': '"dark"' };
  assert.equal(mk(a), 'dark');
  assert.deepEqual(a, { 'coordinator.theme': 'dark' }, 'copied to the new key, old key gone');
  const b = { 'coordinator:theme': '"><x' };
  assert.equal(mk(b), 'system');
  assert.deepEqual(b, {}, 'an unknown old value is dropped, nothing copied');
  const c = { 'coordinator.theme': 'light', 'coordinator:theme': '"dark"' };
  assert.equal(mk(c), 'light', 'the new key wins');
  assert.deepEqual(c, { 'coordinator.theme': 'light' }, 'the old key is removed even when the new one is set');
});

test('rememberToggle: only a toggle after a click on the summary is stored; parsed-open and restored panels are not', () => {
  const d = (key, open, extra = {}) => ({ dataset: { d: key, ...extra }, open });
  const map = {}; const armed = new WeakSet();
  const parsed = d('units', true);
  assert.equal(rememberToggle(map, parsed, armed), false, 'a panel parsed open fires toggle with no click');
  assert.deepEqual(map, {}, 'nothing pinned');
  armed.add(parsed); parsed.open = false;
  assert.equal(rememberToggle(map, parsed, armed), true, 'the reader closed it');
  assert.deepEqual(map, { units: false });
  assert.equal(rememberToggle(map, parsed, armed), false, 'armed once: the restore that follows is not stored');
  const printed = d('tl', true, { po: '1' }); armed.add(printed);
  assert.equal(rememberToggle(map, printed, armed), false, 'opened only for print');
  assert.equal(rememberToggle(map, { dataset: {} }, armed), false);
  assert.deepEqual(map, { units: false });
});

test('theme.client.js: storage that throws is caught; the switch still works for the page', () => {
  const p = themePage({ getThrows: true, setThrows: true });
  assert.equal(p.root.dataset.theme, 'system');
  p.ready();
  assert.doesNotThrow(() => p.radios[2].on.change());
  assert.equal(p.root.dataset.theme, 'dark');
  assert.deepEqual(p.writes, []);
});

test('theme.client.js and live.client.js: their storage keys pass the privacy rule', () => {
  for (const f of ['theme.client.js', 'live.client.js']) {
    const text = readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8');
    const store = privacy([sourceFile(`lib/${f}`, text)]).signals.find((s) => s.id === 'web-storage');
    assert.equal(store, undefined, f);
  }
});

test('restoreOpen: toggles and panels open or closed as the reader left them; untouched ones as rendered', () => {
  const d = (key, open) => ({ dataset: { d: key }, open });
  const nodes = [d('units', true), d('tl', true), d('ev-1', false), d('ev-2', false)];
  const map = restoreOpen(nodes, { tl: false, 'ev-1': true, junk: 'yes' });
  assert.deepEqual(nodes.map((n) => n.open), [true, false, true, false]);
  assert.deepEqual(map, { tl: false, 'ev-1': true, junk: 'yes' }, 'the same map, kept for the next toggles');
  for (const bad of [null, [], 'x', 3]) assert.deepEqual(restoreOpen([d('a', true)], bad), {}, `stored ${JSON.stringify(bad)}: nothing restored`);
});
