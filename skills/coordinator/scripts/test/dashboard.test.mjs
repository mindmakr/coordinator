import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { artifact } from '../lib/evidence.mjs';
import { hud } from '../lib/hud.mjs';
import { linkify } from '../lib/links.mjs';
import { decide } from '../lib/rules.mjs';
import { css, DARK, fromCss, LIGHT } from '../lib/theme.mjs';
import { filter, matches, runTimeline, unitTimeline } from '../lib/timeline.mjs';
import { unitPage } from '../lib/unitpage.mjs';
import { VERSION } from '../lib/version.mjs';
import { view } from '../lib/view.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-dash-'));
const env = { ...process.env, COORDINATOR_DIR: join(dir, 'state') };
const children = [];
after(async () => {
  await Promise.all(children.map((c) => new Promise((ok) => { if (c.exitCode !== null) return ok(); c.once('exit', ok); c.kill(); })));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const run = (...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8', cwd: dir }); return { code: r.status, out: json(r.stdout), err: r.stderr }; };
const runDir = (r) => join(dir, 'state', 'runs', r);
const state = (r) => JSON.parse(readFileSync(join(runDir(r), 'state.json'), 'utf8'));
const setup = (r, ...init) => { run('init', r, '--goal', 'g', '--bar', 'b', '--fence', 'f', ...init); run('add', r, 'u1', '--bar', 'b'); run('add', r, 'u2', '--bar', 'b'); run('freeze', r); };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('behaviours: add, reword, remove; add --behaviour numbers them; ids are checked', () => {
  run('init', 'b1', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  assert.equal(run('add', 'b1', 'u1', '--bar', 'b', '--behaviour', 'Given a payday when it loads then totals add up', '--behaviour', 'It should show SAR').code, 0);
  assert.deepEqual(state('b1').units[0].behaviours.map((b) => [b.id, b.status]), [['B1', 'unchecked'], ['B2', 'unchecked']]);
  assert.equal(run('behave', 'b1', 'u1', '--text', 'It should work in Arabic').out.behaviour, 'B3');
  assert.equal(run('behave', 'b1', 'u1', '--id', 'B2', '--text', 'It should show the Riyal sign').code, 0, 'reworded');
  assert.equal(run('behave', 'b1', 'u1', '--id', 'B1', '--remove').code, 0);
  assert.equal(run('behave', 'b1', 'u1', '--id', '../x', '--text', 't').code, 1, 'bad id');
  assert.equal(run('behave', 'b1', '--text', 't').code, 1, 'a unit or --goal');
  assert.equal(run('behave', 'b1', 'u1', '--goal', '--text', 't').code, 1, 'not both');
  const list = run('behaviours', 'b1').out.units.u1;
  assert.deepEqual(list.map((b) => [b.id, b.text]), [['B2', 'It should show the Riyal sign'], ['B3', 'It should work in Arabic']]);
});

test('a unit cannot pass while a behaviour is failing or unchecked; a pass mark needs evidence', () => {
  setup('b2');
  run('behave', 'b2', 'u1', '--text', 'It should total'); run('behave', 'b2', 'u1', '--text', 'It should round');
  run('start', 'b2', 'u1'); run('built', 'b2', 'u1', '--report', 'fixed totals in 7f8ad63');
  let r = run('verdict', 'b2', 'u1', 'pass', '--evidence', 'tests green', '--score', '9');
  assert.equal(r.code, 1); assert.match(r.err, /pass refused: behaviour B1 \(unchecked\), B2 \(unchecked\)/);
  assert.match(run('verdict', 'b2', 'u1', 'pass', '--evidence', 'e', '--behaviour', 'B1=pass').err, /B1=pass needs evidence/);
  r = run('verdict', 'b2', 'u1', 'pass', '--evidence', 'e', '--score', '9', '--behaviour', 'B1=pass:totals.test 3 passed', '--behaviour', 'B2=fail:rounds down');
  assert.match(r.err, /behaviour B2 \(fail\)/);
  assert.equal(state('b2').units[0].behaviours[0].status, 'unchecked', 'a refused verdict changes nothing');
  assert.equal(run('verdict', 'b2', 'u1', 'fail', '--evidence', 'e', '--gap', 'rounding', '--score', '5', '--behaviour', 'B1=pass:ok', '--behaviour', 'B2=fail:rounds down').code, 0);
  let u = state('b2').units[0];
  assert.deepEqual(u.behaviours.map((b) => b.status), ['pass', 'fail']);
  assert.deepEqual(u.rounds[0].behaviours.map((m) => m.status), ['pass', 'fail']);
  assert.equal(u.rounds[0].report, 'fixed totals in 7f8ad63');
  run('start', 'b2', 'u1');
  assert.deepEqual(state('b2').units[0].behaviours.map((b) => b.status), ['unchecked', 'unchecked'], 'a new build is checked again');
  run('built', 'b2', 'u1');
  assert.equal(run('verdict', 'b2', 'u1', 'pass', '--evidence', 'e', '--score', '9', '--behaviour', 'B1=pass:ok', '--behaviour', 'B2=pass:half-up').code, 0);
  u = state('b2').units[0];
  assert.equal(u.status, 'pass');
  assert.equal(run('behave', 'b2', 'u1', '--text', 'late').code, 1, 'a passed unit keeps its behaviours');
});

test('goal behaviours: integrate cannot pass until each passes; the dashboard says met or not yet', () => {
  setup('g1');
  run('behave', 'g1', '--goal', '--text', 'Given HR approves when payday comes then the money lands');
  for (const u of ['u1', 'u2']) { run('start', 'g1', u); run('built', 'g1', u); run('verdict', 'g1', u, 'pass', '--evidence', 'e', '--score', '9'); }
  assert.match(readFileSync(join(runDir('g1'), 'hud.html'), 'utf8'), /Goal: <span class="chip s-not-yet">not yet<\/span>/);
  assert.match(run('integrate', 'g1', 'pass', '--evidence', 'e').err, /pass refused: behaviour G1/);
  assert.equal(run('evidence', 'g1', '--goal', '--behaviour', 'G1', '--kind', 'log', '--text', 'transfer 42 settled').code, 0);
  assert.equal(run('integrate', 'g1', 'pass', '--evidence', 'e', '--behaviour', 'G1=pass:transfer settled').code, 0);
  const html = readFileSync(join(runDir('g1'), 'hud.html'), 'utf8');
  assert.match(html, /Goal: <span class="chip s-met">met<\/span>/);
  assert.match(html, /transfer 42 settled/);
  assert.match(run('show', 'g1').out, /^goal {4}met \(1\/1 behaviours pass\)$/m);
});

test('evidence: text masked and capped, files checked and copied, urls only http(s), traversal refused', () => {
  setup('e1');
  const long = `${'line\n'.repeat(5000)}`;
  assert.equal(run('evidence', 'e1', 'u1', '--kind', 'test', '--text', `vitest 12 passed DB_PASSWORD=Sup3rS3cret!x ${long}`).code, 0);
  const [e] = state('e1').units[0].evidence;
  assert.match(e.text, /\[redacted\]/); assert.doesNotMatch(e.text, /Sup3rS3cret/);
  assert.ok(e.text.length < 20_100); assert.match(e.text, /cut at 20000 characters/);
  writeFileSync(join(dir, 'shot.png'), PNG);
  writeFileSync(join(dir, 'fake.png'), 'not an image');
  writeFileSync(join(dir, 'run.log'), 'ok\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(join(dir, 'x.html'), '<script>');
  assert.equal(run('evidence', 'e1', 'u1', '--kind', 'screenshot', '--file', join(dir, 'shot.png'), '--label', 'Home 390').code, 0);
  assert.match(run('evidence', 'e1', 'u1', '--kind', 'screenshot', '--file', join(dir, 'fake.png')).err, /does not look like a png/);
  assert.match(run('evidence', 'e1', 'u1', '--kind', 'log', '--file', join(dir, 'x.html')).err, /--file must be/);
  assert.match(run('evidence', 'e1', 'u1', '--kind', 'log', '--file', join(dir, 'nope.png')).err, /no file/);
  assert.equal(run('evidence', 'e1', 'u1', '--kind', 'log', '--file', join(dir, 'run.log')).code, 0);
  assert.equal(run('evidence', 'e1', 'u1', '--kind', 'link', '--url', 'javascript:alert(1)').code, 1);
  assert.equal(run('evidence', 'e1', 'u1', '--kind', 'link', '--url', 'https://github.com/o/r/pull/7').code, 0);
  assert.equal(run('evidence', 'e1', 'u1', '--kind', 'link', '--url', 'https://x', '--text', 't').code, 1, 'one source only');
  assert.equal(run('evidence', 'e1', '../u1', '--kind', 'link', '--url', 'https://x').code, 1, 'unit ids are checked');
  const s = state('e1');
  const files = s.units[0].evidence.filter((x) => x.file).map((x) => x.file);
  assert.deepEqual(files, ['u1/E2-shot.png', 'u1/E3-run.log']);
  assert.doesNotMatch(readFileSync(join(runDir('e1'), 'artifacts', 'u1', 'E3-run.log'), 'utf8'), /ghp_/, 'text files are masked');
  assert.deepEqual(artifact(s, 'u1', 'E2-shot.png'), { rel: 'u1/E2-shot.png', type: 'image/png' });
  for (const [t, n] of [['u1', '../state.json'], ['u1', '..'], ['..', 'state.json'], ['u1', 'E9-other.png'], ['u2', 'E2-shot.png']]) assert.equal(artifact(s, t, n), null, `${t}/${n}`);
  const html = readFileSync(join(runDir('e1'), 'units', 'u1.html'), 'utf8');
  assert.match(html, /<img class="thumb" src="data:image\/png;base64,/, 'the snapshot embeds small screenshots');
  assert.match(html, /<details class="raw pre" data-d="p-u1-ev-E1">/, 'long test output is collapsed');
});

test('links: http(s), owner/repo#n, #n, shas and branches; nothing else', () => {
  const out = linkify('PR #12 in o/r#3, 7f8ad63 on feat/x, see https://e.com/a). javascript:alert(1) <b>', 'm/p');
  assert.match(out, /<a href="https:\/\/github.com\/m\/p\/issues\/12" target="_blank" rel="noopener noreferrer">#12<\/a>/);
  assert.match(out, /href="https:\/\/github.com\/o\/r\/issues\/3"/);
  assert.match(out, /href="https:\/\/github.com\/m\/p\/commit\/7f8ad63"/);
  assert.match(out, /href="https:\/\/github.com\/m\/p\/tree\/feat\/x"/);
  assert.match(out, /href="https:\/\/e.com\/a" target="_blank" rel="noopener noreferrer">https:\/\/e.com\/a<\/a>\)\./, 'trailing punctuation stays outside');
  assert.doesNotMatch(out, /href="javascript|<b>/);
  assert.equal(linkify('#12 7f8ad63 feat/x', null), '#12 7f8ad63 feat/x', 'no repo: no guesses');
  setup('l1', '--repo', 'm/p');
  assert.equal(run('init', 'l2', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--repo', 'not a repo').code, 1);
  assert.equal(run('link', 'l1', 'u1', '--issue', '#4', '--pr', 'o/web#9', '--pr', 'https://github.com/o/mobile/pull/2').code, 0);
  assert.equal(run('link', 'l1', 'u1', '--pr', 'javascript:x').code, 1);
  assert.deepEqual(state('l1').units[0].links.map((l) => l.url), ['https://github.com/m/p/issues/4', 'https://github.com/o/web/pull/9', 'https://github.com/o/mobile/pull/2']);
  assert.match(readFileSync(join(runDir('l1'), 'hud.html'), 'utf8'), /<span class="badge k-link">pr<\/span> <a href="https:\/\/github.com\/o\/web\/pull\/9" target="_blank"/);
});

test('theme: a project CSS maps onto the HUD tokens; unsafe values are dropped', () => {
  const t = fromCss(`/* --primary: red; */
    :root { --background: 0 0% 100%; --foreground: #171717; --primary: var(--brand); --brand: oklch(0.5 0.1 260); --radius: 0.75rem; --font-sans: var(--font-x), Inter, system-ui; --muted-foreground: url(https://evil/x.png); }
    .dark { --background: #0a0a0a; --foreground: #ededed; }
    @plugin "daisyui/theme" { name: dark; --color-error: oklch(80% 0.1 20); }
    @theme { --border: 1px; --color-base-300: #ddd; --spacing: 0.25rem; }`);
  assert.equal(t.light.bg, 'hsl(0 0% 100%)');
  assert.equal(t.light.run, 'oklch(0.5 0.1 260)', 'var() resolved');
  assert.equal(t.light.line, '#ddd', '--border: 1px is not a colour');
  assert.equal(t.light.radius, '0.75rem');
  assert.equal(t.light.font, 'Inter, system-ui', 'runtime font variables dropped');
  assert.equal(t.light.gap, 'calc(0.25rem * 3)');
  assert.match(t.light.muted, /^color-mix/, 'the unsafe value is ignored, muted is derived');
  assert.equal(t.dark.bg, '#0a0a0a'); assert.equal(t.dark.fail, 'oklch(80% 0.1 20)');
  const out = css(t);
  assert.doesNotMatch(out, /url\(|evil|<|@import/);
  assert.match(out, /:root:has\(#theme-dark:checked\)/);
  const payday = 'D:/projects/mindmakr/payday-web-nextjs/frontend/src/app/globals.css';
  if (existsSync(payday)) {
    const p = fromCss(readFileSync(payday, 'utf8'));
    assert.equal(p.light.card, 'oklch(1 0 0)'); assert.equal(p.light.run, 'oklch(0.1758 0.0643 257.72)');
    assert.equal(p.dark.card, 'oklch(0.1758 0.0643 257.72)'); assert.equal(p.light.radius, '0.75rem');
  }
  assert.deepEqual(fromCss('').light.bg, LIGHT.bg); assert.equal(DARK.scheme, 'dark');
});

test('timelines: a unit holds only its own events in order; filters, ranges and sort', () => {
  setup('t1');
  run('start', 't1', 'u1'); run('beat', 't1', 'u1', '--text', 'pushed'); run('start', 't1', 'u2');
  run('built', 't1', 'u1'); run('note', 't1', '--kind', 'person', '--text', 'u2 note', '--unit', 'u2');
  run('ask', 't1', '--question', 'Merge?', '--header', 'Merge', '--option', 'Yes', '--option', 'No', '--unit', 'u1');
  run('answer', 't1', 'q1', '--choice', 'Yes');
  run('verdict', 't1', 'u1', 'fail', '--evidence', 'e', '--gap', 'g', '--cause', 'off by one', '--score', '4');
  run('evidence', 't1', 'u1', '--kind', 'log', '--text', 'log');
  run('link', 't1', 'u1', '--merge', 'https://github.com/o/r/pull/1');
  const s = state('t1');
  const u1 = unitTimeline(s, 'u1');
  assert.deepEqual(u1.map((e) => e.label), ['start', 'beat', 'built', 'question', 'answer', 'verdict fail', 'evidence', 'merge']);
  assert.ok(u1.every((e) => e.unit === 'u1'));
  assert.deepEqual(u1.map((e) => e.at), [...u1.map((e) => e.at)].sort());
  assert.equal(u1[5].cause, 'off by one'); assert.equal(u1[5].score, 4);
  assert.deepEqual(unitTimeline(s, 'u2').map((e) => e.label), ['start', 'person']);
  const now = Date.parse('2026-11-06T12:00:00Z');
  const ev = (min, badge, unit = 'u1', text = 'x') => ({ at: new Date(now - min * 60_000).toISOString(), badge, label: badge, unit, who: '', text });
  const all = [ev(10, 'pass'), ev(100, 'fail', 'u2', 'Totals off'), ev(200, 'note'), ev(2000, 'decision', null), ev(20_000, 'stop')];
  const ages = (f) => filter(all, f, now).map((e) => Math.round((now - Date.parse(e.at)) / 60_000));
  assert.deepEqual(ages({ range: '30m' }), [10]);
  assert.deepEqual(ages({ range: '120m' }), [10, 100]);
  assert.deepEqual(ages({ range: '4h' }), [10, 100, 200]);
  assert.deepEqual(ages({ range: '24h' }), [10, 100, 200]);
  assert.deepEqual(ages({ range: '2-7d' }), [2000]);
  assert.deepEqual(ages({ range: '8d' }), [20_000]);
  assert.deepEqual(ages({ range: 'all', sort: 'oldest' }), [20_000, 2000, 200, 100, 10]);
  assert.deepEqual(ages({ kinds: ['pass', 'fail'] }), [10, 100]);
  assert.deepEqual(ages({ units: ['u2'] }), [100]);
  assert.deepEqual(ages({ units: [''] }), [2000], 'run-level events');
  assert.deepEqual(ages({ q: 'totals' }), [100]);
  assert.equal(matches(ev(-1, 'pass'), { range: '30m' }, now), true, 'a clock a little ahead still counts');
  assert.ok(runTimeline(s).length > u1.length);
});

test('the drilldown page: behaviours, rounds, notes, links and its own timeline, keyboard reachable', () => {
  setup('d1', '--repo', 'm/p');
  run('behave', 'd1', 'u1', '--text', 'It should total');
  run('start', 'd1', 'u1'); run('built', 'd1', 'u1', '--report', 'see 7f8ad63');
  run('verdict', 'd1', 'u1', 'fail', '--evidence', 'e', '--gap', 'off by #3', '--cause', 'rounding', '--score', '4', '--behaviour', 'B1=fail:off');
  run('note', 'd1', '--kind', 'person', '--text', 'check RTL', '--unit', 'u1');
  const file = readFileSync(join(runDir('d1'), 'units', 'u1.html'), 'utf8');
  assert.match(file, /<a class="back" href="\.\.\/hud\.html">← d1 dashboard<\/a>/);
  assert.match(file, /<title>u1 · d1 · Coordinator<\/title>/);
  assert.match(file, /Round 1 <span class="chip s-fail">fail<\/span>/);
  assert.match(file, /Builder's report<\/dt><dd>see <a href="https:\/\/github.com\/m\/p\/commit\/7f8ad63"/);
  assert.match(file, /off by <a href="https:\/\/github.com\/m\/p\/issues\/3"/);
  assert.match(file, /check RTL/);
  assert.match(file, /Timeline of u1/);
  assert.doesNotMatch(file, /<script|<form/);
  assert.match(readFileSync(join(runDir('d1'), 'hud.html'), 'utf8'), /<a class="open" href="units\/u1\.html">Open u1 →<\/a>/);
  const s = state('d1');
  const live = unitPage(view(s, decide(s)), 'u1', Date.now(), { token: 'tok', nonce: 'n' });
  assert.match(live, /href="\/\?t=tok"/); assert.match(live, /name="back" value="\/unit\/u1"/);
  assert.equal(unitPage(view(s, decide(s)), 'nope'), null);
});

test('an old state file (no behaviours, evidence, logs, links or repo) renders everywhere', () => {
  const old = {
    id: 'old', tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [], createdAt: '2026-01-01T00:00:00Z', frozen: true, addedAfterFreeze: 0,
    budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, integration: { rounds: [] }, closed: null, notes: [],
    units: [{ id: 'u1', bar: 'b', after: null, status: 'pass', strategyChanges: 0, strategyAt: -1, stopReason: null, rounds: [{ n: 1, verdict: 'pass', score: 9, gap: null, evidence: 'e', at: '2026-01-01T00:10:00Z' }] }],
  };
  const v = view(old, decide(old, Date.parse('2026-01-01T00:20:00Z')));
  assert.equal(v.goalCheck.met, false); assert.deepEqual(v.units[0].behaviours, []);
  assert.match(hud(v), /Goal: <span class="chip s-not-yet">/);
  assert.match(unitPage(v, 'u1'), /Round 1/);
  assert.deepEqual(unitTimeline(old, 'u1').map((e) => e.label), ['verdict pass']);
});

test('serve: live updates over SSE on change, artifacts and pages need the token', async () => {
  setup('s1');
  writeFileSync(join(dir, 'shot2.png'), PNG);
  run('evidence', 's1', 'u1', '--kind', 'screenshot', '--file', join(dir, 'shot2.png'));
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 's1', '--port', '0'], { env, cwd: dir });
  children.push(c);
  const url = await new Promise((ok) => { let b = ''; c.stdout.on('data', (d) => { b += d; const m = /"url": ?"([^"]+)"/.exec(b); if (m) ok(m[1]); }); });
  const { origin } = new URL(url); const t = new URL(url).searchParams.get('t');
  const get = (p) => new Promise((ok) => httpGet(`${origin}${p}`, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => ok({ status: res.statusCode, body: d, type: res.headers['content-type'] })); }));
  assert.equal((await get('/events?p=/')).status, 403, 'no token');
  assert.equal((await get(`/events?t=${t}&p=/etc/passwd`)).status, 400);
  assert.equal((await get('/unit/u1')).status, 403);
  assert.equal((await get(`/unit/u1?t=${t}`)).status, 200);
  assert.equal((await get(`/unit/nope?t=${t}`)).status, 404);
  const img = await get(`/artifacts/u1/E1-shot2.png?t=${t}`);
  assert.equal(img.status, 200); assert.equal(img.type, 'image/png');
  assert.equal((await get('/artifacts/u1/E1-shot2.png')).status, 403);
  for (const p of ['/artifacts/u1/..%2Fstate.json', '/artifacts/../state.json', '/artifacts/u1/state.json', '/artifacts/u2/E1-shot2.png']) assert.notEqual((await get(`${p}?t=${t}`)).status, 200, p);
  const page = (await get(`/?t=${t}`)).body;
  assert.match(page, /<script nonce="[^"]+">const matches = function matches/);
  assert.match(page, /<img class="thumb" src="\/artifacts\/u1\/E1-shot2\.png\?t=/);
  assert.match(page, /Coordinator<\/b><span>by <a href="https:\/\/github.com\/mindmakr" target="_blank"/);
  const frames = [];
  const stream = await new Promise((ok) => httpGet(`${origin}/events?t=${t}&p=/`, (res) => { res.setEncoding('utf8'); res.on('data', (d) => frames.push(d)); ok(res); }));
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  const until = async (re) => { for (let i = 0; i < 80; i++) { if (re.test(frames.join(''))) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`no frame matching ${re}`); };
  await until(/event: patch\ndata: \{"html":/);
  run('note', 's1', '--kind', 'situation', '--text', 'Live change arrived');
  await until(/Live change arrived/);
  stream.destroy();
});

test('every time is a <time> with an ISO datetime; the snapshot spells out UTC; the live page localises', () => {
  setup('ts1');
  run('note', 'ts1', '--kind', 'situation', '--text', 'busy');
  run('start', 'ts1', 'u1'); run('built', 'ts1', 'u1');
  run('verdict', 'ts1', 'u1', 'fail', '--evidence', 'e', '--gap', 'g', '--score', '3');
  run('evidence', 'ts1', 'u1', '--kind', 'log', '--text', 'x');
  run('note', 'ts1', '--kind', 'person', '--text', 'hi', '--unit', 'u1');
  const iso = /<time datetime="(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"(?: class="cause")? title="(\d{4}-\d\d-\d\d \d\d:\d\d UTC)">\2<\/time>/g;
  for (const f of ['hud.html', 'units/u1.html']) {
    const html = readFileSync(join(runDir('ts1'), f), 'utf8');
    const stamps = [...html.matchAll(iso)];
    assert.ok(stamps.length >= 4, `${f}: ${stamps.length} stamps`);
    for (const [, at, shown] of stamps) assert.equal(shown, `${at.slice(0, 16).replace('T', ' ')} UTC`);
    assert.equal((html.match(/<time\b/g) ?? []).length, stamps.length, `${f}: every <time> carries an ISO datetime`);
    assert.doesNotMatch(html, /\d\d:\d\d<\/span>/, 'no bare clock text outside a <time>');
  }
  assert.match(readFileSync(join(runDir('ts1'), 'hud.html'), 'utf8'), /Situation · the lead, <time datetime=/);
  const s = state('ts1');
  const live = hud(view(s, decide(s)), Date.now(), { token: 't', nonce: 'n' });
  assert.match(live, /new Intl\.DateTimeFormat\(undefined/);
  assert.match(live, /querySelectorAll\('time\[datetime\]'\)/);
  assert.match(live, /data-at="\d{4}-/, 'filters still read the raw timestamp');
});

test('the footer version matches the plugin', () => {
  const plugin = JSON.parse(readFileSync(join(scripts, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.version, VERSION);
});
