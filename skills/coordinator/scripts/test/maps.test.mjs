import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { behaviourGrid, heat, MAX_COLS, waits } from '../lib/heat.mjs';
import { staticCtx } from '../lib/hud.mjs';
import { criticalPath, flowGraph, ghRef, mindGraph, refsIn, relevance } from '../lib/maps.mjs';
import { mapsPage } from '../lib/mapspage.mjs';
import { flowSvg, link, mindSvg } from '../lib/mapsvg.mjs';

const T0 = Date.parse('2026-11-06T06:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const ev = (min, label, badge = 'build') => ({ at: at(min), label, badge });

// A view model as lib/view.mjs builds it, with only the fields the maps read.
function unit(id, o = {}) {
  return { id, title: null, bar: 'b', status: 'open', dot: 'waiting', after: null, link: null, links: [], behaviours: [], evidenceItems: [], timeline: [], asks: [], ...o };
}
function viewOf(units, o = {}) {
  return { id: 'r', goal: 'g', repo: 'acme/web', started: at(0), open: true, closedAt: null, phase: 'continue', goalCheck: { behaviours: [], evidence: [], met: false }, followUpNotes: [], units, ...o };
}
const issue = (repo, n, kind = 'issue') => ({ kind, url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}` });

test('GitHub references: URLs, owner/repo#n and #n against the run repo; nothing else', () => {
  assert.equal(ghRef('https://github.com/acme/web/pull/7').kind, 'pr');
  assert.equal(ghRef('https://github.com/acme/web/issues/7').key, 'acme/web#7');
  assert.equal(ghRef('javascript:alert(1)'), null);
  assert.equal(ghRef('https://example.com/acme/web/issues/7'), null);
  assert.deepEqual(refsIn('see #12, acme/app#3 and https://github.com/acme/web/pull/12 (dupe) and x#9', 'acme/web').map((r) => r.key), ['acme/web#12', 'acme/app#3']);
  assert.deepEqual(refsIn('#5', null), [], 'no repo, no #n');
});

test('critical path: the stacked chain with the most work; unfinished units count at the median', () => {
  const done = (id, mins, o = {}) => unit(id, { status: 'pass', dot: 'passed', timeline: [ev(0, 'start'), ev(mins, 'verdict pass', 'pass')], ...o });
  const units = [done('a', 60), done('b', 20), unit('c', { after: 'a' }), unit('d', { after: 'c' }), done('e', 100)];
  const c = criticalPath(units, T0);
  assert.equal(c.estimate, 60, 'median of 60, 20 and 100');
  assert.deepEqual(c.path, ['a', 'c', 'd']);
  assert.equal(c.minutes, 180); assert.equal(c.left, 2);
  assert.deepEqual(criticalPath([unit('x', { after: 'y' }), unit('y', { after: 'x' })], T0).path.length, 2, 'a cycle ends the walk');
  assert.deepEqual(criticalPath([], T0).path, []);
  assert.equal(criticalPath([done('a', 60), unit('b')], T0).stacked, false, 'no stacking, no path');
  assert.deepEqual(criticalPath([done('a', 60), unit('b')], T0).path, []);
  const f = done('f', 60);
  const running = unit('r', { after: 'f', status: 'building', timeline: [ev(0, 'start')] });
  assert.equal(criticalPath([f, running], T0 + 20 * 60_000).minutes, 60 + 60, 'running 20 min of a 60 min median: 40 left, so it weighs 60');
  assert.equal(criticalPath([f, running], T0 + 90 * 60_000).minutes, 60 + 90, 'past the median: its time so far, nothing added');
});

test('flow graph: stacking edges, one node per shared issue, cross-repo links, follow-ups attached', () => {
  const v = viewOf([
    unit('u1', { links: [issue('acme/web', 1), issue('acme/web', 9, 'pr')] }),
    unit('u2', { after: 'u1', links: [issue('acme/web', 1), issue('acme/mobile', 4)] }),
    unit('u3', { after: 'u2' }),
  ], { followUpNotes: [{ text: 'acme/web#1 needs a test' }, { text: 'u3: rename later' }, { text: 'unrelated', unit: null }] });
  const g = flowGraph(v, T0);
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'unit').map((n) => [n.unit, n.depth]), [['u1', 0], ['u2', 1], ['u3', 2]]);
  assert.deepEqual(g.edges.filter((e) => e.kind === 'after').map((e) => [e.from, e.to, e.crit]), [['u:u1', 'u:u2', true], ['u:u2', 'u:u3', true]]);
  const shared = g.nodes.find((n) => n.id === 'r:acme/web#1');
  assert.deepEqual(shared.units, ['u1', 'u2']); assert.equal(shared.label, '#1'); assert.equal(shared.cross, false);
  const mobile = g.nodes.find((n) => n.id === 'r:acme/mobile#4');
  assert.equal(mobile.cross, true); assert.equal(mobile.label, 'mobile#4');
  assert.equal(g.nodes.find((n) => n.id === 'r:acme/web#9').kind, 'pr');
  const fus = g.nodes.filter((n) => n.kind === 'follow-up');
  assert.deepEqual(fus.map((f) => f.units), [['u1', 'u2'], ['u3'], []]);
  assert.equal(fus[0].url, 'https://github.com/acme/web/issues/1');
  assert.deepEqual(g.critical.path, ['u1', 'u2', 'u3']);
});

test('mind graph: goal → units → behaviours → evidence; evidence without a behaviour hangs off its unit; capped', () => {
  const ev7 = Array.from({ length: 8 }, (_, i) => ({ id: `E${i}`, kind: 'test', behaviour: 'B1', label: `t${i}` }));
  const v = viewOf([unit('u1', { behaviours: [{ id: 'B1', text: 't', status: 'pass' }], evidenceItems: [...ev7, { id: 'L', kind: 'link', url: 'https://x.test' }] })]);
  const g = mindGraph(v);
  assert.equal(g.nodes[0].kind, 'goal');
  assert.equal(g.nodes.find((n) => n.id === 'b:u1:B1').parent, 'u:u1');
  assert.equal(g.nodes.find((n) => n.id === 'e:u1:L').parent, 'u:u1');
  assert.equal(g.nodes.filter((n) => n.parent === 'b:u1:B1' && n.kind === 'evidence').length, 6);
  assert.equal(g.nodes.find((n) => n.kind === 'more').label, '+2');
  assert.equal(g.edges.length, g.nodes.length - 1, 'a tree');
});

test('heat: hour buckets count tries, failures, beats and waiting; long runs widen the buckets', () => {
  const u = unit('u1', { status: 'judging', timeline: [ev(5, 'start'), ev(10, 'beat'), ev(20, 'beat'), ev(50, 'built'), ev(80, 'verdict fail', 'fail'), ev(90, 'start'), ev(100, 'built'), ev(130, 'question', 'question')],
    asks: [{ at: at(130), open: true, history: [] }] });
  const h = heat(viewOf([u]), T0 + 3 * 3_600_000);
  assert.equal(h.step, 1); assert.equal(h.cols.length, 3);
  const [c0, c1, c2] = h.rows[0].cells;
  assert.deepEqual([c0.beats, c0.other, c0.rounds, c0.waitMin], [2, 2, 0, 10], 'start, built; built at :50 waits 10 min in hour 0');
  assert.deepEqual([c1.rounds, c1.fails, c1.waitMin, c1.kind], [1, 1, 20 + 20, 'fail'], 'verdict at 1:20; waits 1:00–1:20 and 1:40–2:00');
  assert.equal(c2.waitMin, 60, 'judging and an open question overlap: counted once');
  assert.equal(c2.kind, 'wait');
  assert.equal(h.rows[0].total.rounds, 1);
  assert.deepEqual(waits(u, T0 + 180 * 60_000).map(([a, b]) => (b - a) / 60_000), [30, 80, 50]);
  const long = heat(viewOf([unit('u1')], { open: false, closedAt: at(60 * 100) }), T0);
  assert.equal(long.step, 3); assert.ok(long.cols.length <= MAX_COLS);
  assert.equal(heat(viewOf([]), T0).rows.length, 0);
});

test('behaviour grid and relevance: named, inferred and off goal', () => {
  const v = viewOf([
    unit('u1', { bar: 'Serves G1 directly', behaviours: [{ id: 'B1', text: 'x', status: 'pass' }, { id: 'B2', text: 'y', status: 'fail' }] }),
    unit('u2', { bar: 'Employees see payday advance totals in Arabic' }),
    unit('u3', { bar: 'Refresh the marketing hero' }),
  ], { goalCheck: { met: false, evidence: [], behaviours: [{ id: 'G1', text: 'one', status: 'pass' }, { id: 'G2', text: 'Employees see payday totals in SAR and Arabic', status: 'unchecked' }] } });
  const b = behaviourGrid(v);
  assert.equal(b.cols, 2); assert.equal(b.rows[0].label, 'Goal'); assert.deepEqual([b.pass, b.fail, b.unchecked], [2, 1, 1]);
  const r = relevance(v);
  assert.deepEqual(r.units.map((u) => [u.unit, u.distance]), [['u1', 0], ['u2', 1], ['u3', null]]);
  assert.deepEqual(r.units[1].serves.map((s) => s.target), ['G2']);
  assert.deepEqual(r.off, ['u3']);
  // No goal behaviours: the goal itself, named by an issue the unit links.
  const g = relevance(viewOf([unit('u1', { links: [issue('acme/web', 12)] }), unit('u2')], { goal: 'Ship #12' }));
  assert.deepEqual(g.units.map((u) => u.distance), [0, null]);
  assert.equal(g.targets[0].id, 'goal');
});

test('rendering: state text escaped, only http(s) links leave the page, every node focusable', () => {
  assert.equal(link('javascript:alert(1)', 'x', '<circle/>', true).includes('href'), false);
  assert.match(link('https://github.com/a/b/issues/1', 'x"y', '', true), /target="_blank" rel="noopener noreferrer" aria-label="x&quot;y"/);
  const evil = '<script>alert(1)</script>';
  const v = viewOf([unit('u1', { title: evil, behaviours: [{ id: 'B1', text: evil, status: 'fail' }], evidenceItems: [{ id: 'E1', kind: 'link', url: 'javascript:alert(2)', label: evil }], links: [issue('acme/web', 3)] })],
    { goal: evil, followUpNotes: [{ text: `${evil} #3` }] });
  const html = mapsPage(v, T0, staticCtx('', 0));
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /href="units\/u1\.html"/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/web\/issues\/3" target="_blank" rel="noopener noreferrer"/);
  assert.equal(/<script/i.test(html), false, 'the snapshot has no script');
  for (const id of ['mind', 'flow', 'heat', 'behaviours', 'relevance']) assert.match(html, new RegExp(`data-k="map-${id}"`));
  const svg = mindSvg(v, staticCtx('', 0)) + flowSvg(v, staticCtx('', 0), T0);
  const shapes = svg.match(/<(a|g role="img")\b/g).length;
  assert.ok(shapes >= 6, 'nodes are links or labelled images');
  assert.match(mapsPage(viewOf([]), T0, staticCtx('', 0)), /No units yet/);
  assert.match(html, /No stacked work/, 'one unit: no critical path shown');
  assert.match(html, /<div class="map-scroll flow" tabindex="0" role="region" aria-label="Flow map/);
  const fu = flowSvg(v, staticCtx('', 0), T0);
  assert.ok(fu.indexOf('edge follow-up') > fu.indexOf('nd ref'), 'follow-up edges drawn above the issue nodes');
});

test('layout stays inside its box for 1 to 12 units', () => {
  for (const n of [1, 2, 5, 12]) {
    const units = Array.from({ length: n }, (_, i) => unit(`u${i + 1}`, { after: i % 3 ? `u${i}` : null, links: [issue('acme/web', i + 1)], behaviours: [{ id: 'B1', text: 't', status: 'pass' }] }));
    const html = mapsPage(viewOf(units), T0, staticCtx('', 0));
    for (const m of html.matchAll(/<svg class="map[^"]*" viewBox="0 0 (\d+) (\d+)"[\s\S]*?<\/svg>/g)) {
      const [w, h] = [+m[1], +m[2]];
      assert.ok(w > 0 && h > 0 && w < 3000 && h < 3000, `${n} units: ${w}x${h}`);
      for (const c of m[0].matchAll(/ (?:x|cx)="(-?[\d.]+)"/g)) assert.ok(+c[1] >= 0 && +c[1] <= w, `${n} units: x ${c[1]} in 0..${w}`);
      for (const c of m[0].matchAll(/ (?:y|cy)="(-?[\d.]+)"/g)) assert.ok(+c[1] >= 0 && +c[1] <= h, `${n} units: y ${c[1]} in 0..${h}`);
    }
  }
});

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-maps-'));
const env = { ...process.env, COORDINATOR_DIR: join(dir, 'state') };
const children = [];
after(async () => {
  await Promise.all(children.map((c) => new Promise((ok) => { if (c.exitCode !== null) return ok(); c.once('exit', ok); c.kill(); })));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const run = (...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8', cwd: dir });

test('snapshot writes maps.html; serve shows /maps and /run/<other>/maps behind the token', async () => {
  run('init', 'm1', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--repo', 'acme/web');
  run('add', 'm1', 'u1', '--bar', 'b', '--issue', '#4');
  run('add', 'm1', 'u2', '--bar', 'b', '--after', 'u1');
  run('init', 'm2', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  const file = join(dir, 'state', 'runs', 'm1', 'maps.html');
  assert.ok(existsSync(file));
  const snap = readFileSync(file, 'utf8');
  assert.match(snap, /Maps · m1/); assert.match(snap, /href="https:\/\/github\.com\/acme\/web\/issues\/4"/);
  assert.match(readFileSync(join(dir, 'state', 'runs', 'm1', 'hud.html'), 'utf8'), /href="maps\.html"/);
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'm1', '--port', '0'], { env, cwd: dir });
  children.push(c);
  const url = await new Promise((ok) => { let b = ''; c.stdout.on('data', (d) => { b += d; const m = /"url": ?"([^"]+)"/.exec(b); if (m) ok(m[1]); }); });
  const { origin } = new URL(url); const t = new URL(url).searchParams.get('t');
  const get = (p) => new Promise((ok) => httpGet(`${origin}${p}`, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => ok({ status: res.statusCode, body: d })); }));
  assert.equal((await get('/maps')).status, 403);
  const page = await get(`/maps?t=${t}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /aria-current="page">Maps</);
  assert.match(page.body, /href="\/unit\/u1\?t=/);
  assert.match((await get(`/?t=${t}`)).body, /href="\/maps\?t=/);
  const other = await get(`/run/m2/maps?t=${t}`);
  assert.equal(other.status, 200); assert.match(other.body, /Maps · m2/);
  assert.equal((await get(`/run/nope/maps?t=${t}`)).status, 404);
  const sse = await new Promise((ok) => httpGet(`${origin}/events?t=${t}&p=/maps`, (res) => { res.once('data', () => { ok(res.statusCode); res.destroy(); }); }));
  assert.equal(sse, 200, 'the maps page updates live');
});
