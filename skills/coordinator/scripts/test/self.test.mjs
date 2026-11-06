import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseContext, selfModel, selfText } from '../lib/self.mjs';
import { SECTIONS, selfPage } from '../lib/selfpage.mjs';
import { staticCtx } from '../lib/hud.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-self-'));
const env = { ...process.env, COORDINATOR_DIR: join(dir, 'state') };
const children = [];
after(async () => {
  await Promise.all(children.map((c) => new Promise((ok) => { if (c.exitCode !== null) return ok(); c.once('exit', ok); c.kill(); })));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const cli = (script, ...a) => { const r = spawnSync(process.execPath, [join(scripts, script), ...a], { env, encoding: 'utf8', cwd: dir }); return { code: r.status, out: json(r.stdout), raw: r.stdout, err: r.stderr }; };
const run = (...a) => cli('run.mjs', ...a);
const state = (r) => JSON.parse(readFileSync(join(dir, 'state', 'runs', r, 'state.json'), 'utf8'));

const T0 = '2026-11-01T10:00:00.000Z';
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
// An old-shape run: no studies, no maxStudies, no unit log.
const oldRun = (id, units, closed = null, extra = {}) => ({
  id, tag: 'code', goal: `goal of ${id}`, bar: 'b', fence: 'f', paths: [], createdAt: T0, frozen: true, addedAfterFreeze: 0,
  budget: { maxRounds: 4, maxMinutes: 100_000, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
  units, notes: [], integration: { rounds: [] }, closed, ...extra,
});
const unit = (id, status, verdicts, more = {}) => ({
  id, bar: 'b', status, after: null, strategyChanges: 0, strategyAt: -1, heartbeatAt: null, stopReason: status === 'stopped' ? 'no progress' : null,
  rounds: verdicts.map((v, i) => ({ n: i + 1, verdict: v, score: v === 'pass' ? 9 : 5, gap: v === 'pass' ? null : 'g', at: at(30 * (i + 1)) })), ...more,
});

test('the model: age, stats, history, plans with who each unit waits on, proposals, decisions; old state loads', () => {
  const a = oldRun('r-a', [unit('u1', 'pass', ['pass']), unit('u2', 'pass', ['fail', 'fail', 'pass']), unit('u3', 'stopped', ['fail', 'fail'])], { outcome: 'partial', decision: 'done', at: at(120) });
  a.notes.push({ kind: 'follow-up', text: 'upstream: the stale stop fires too early', at: at(100) }, { kind: 'follow-up', text: 'Payroll menu misses a link', at: at(101) });
  a.notes.push({ kind: 'question', text: 'Merge now?', header: 'Merge', options: [{ label: 'Yes' }, { label: 'No' }], at: at(5), history: [{ choices: ['Yes'], other: null, by: 'person', at: at(6) }] });
  const b = oldRun('r-b', [unit('v1', 'building', []), unit('v2', 'open', [], { after: 'v1' }), unit('v3', 'judging', [])]);
  b.createdAt = at(200);
  const m = selfModel({ runs: [b, a], lessons: { global: [{ id: 'l1', tag: 'security', text: 'Check auth', seen: 3, used: 1, from: ['r-a'], firstAt: T0, lastAt: T0 }], project: [] }, context: '# C\n## Checks\n- `npm test`\n## Never\n- push to main\n', nowMs: Date.parse(at(240)) });
  assert.equal(m.age.runs, 2); assert.equal(m.age.firstRunId, 'r-a'); assert.equal(m.age.units, 6); assert.equal(m.age.open, 1);
  assert.equal(m.stats.passRate, 67); assert.equal(m.stats.stoppedShare, 33);
  assert.equal(m.stats.medianRoundsToPass, 1); assert.equal(m.stats.p80RoundsToPass, 3);
  assert.equal(m.stats.minutesPerUnit, 60, 'from the run start (no start log) to the last verdict');
  assert.deepEqual(m.history.map((h) => [h.run, h.outcome, h.passed, h.stopped]), [['r-a', 'partial', 2, 1]]);
  assert.deepEqual(m.plans[0].left.map((u) => [u.id, u.waitsOn]), [['v1', 'its builder'], ['v2', 'v1'], ['v3', 'a critic']]);
  assert.deepEqual(m.plans[0].next, ['judge v3']);
  assert.deepEqual(m.proposals.map((p) => p.kind).sort(), ['follow-up', 'promote', 'upstream']);
  assert.equal(m.memory.decisions[0].answer, 'Yes');
  assert.deepEqual(m.memory.context.map((s) => s.title), ['Checks', 'Never']);
  assert.equal(m.learning.lessons[0].promote, true);
  assert.deepEqual(m.study.runs, [{ run: 'r-b', used: 0, cap: 2, open: true }], 'old state: default study cap');
  assert.equal(m.learning.lessons[0].sources.length, 0, 'an old lesson without sources loads');
  assert.equal(m.stats.basis, 'all runs, open included');
  assert.deepEqual(m.stats.closed, { runs: 1, units: 3, passRate: 67, medianRoundsToPass: 1, p80RoundsToPass: 3, stoppedShare: 33 });
  const t = selfText(m);
  for (const w of ['(all runs, open included)', 'stopped 33% · 3 units in 1 closed run (as run.mjs stats)', '2 runs (1 open)', 'pass rate 67%', 'median 1, p80 3', 'v2 open · waits on v1', 'r-a partial', '[upstream]', '0 studies']) assert.ok(t.includes(w), w);
});

test('the model with nothing: no runs, no lessons, no COORDINATOR.md', () => {
  const m = selfModel({ runs: [] });
  assert.equal(m.age.runs, 0); assert.equal(m.stats.passRate, null);
  const html = selfPage(m, Date.now(), staticCtx('', 0));
  assert.match(html, /No run yet/); assert.match(html, /No COORDINATOR\.md/);
  assert.match(selfText(m), /no open run/);
  assert.match(selfText(m), /no closed run yet \(run\.mjs stats counts closed runs only\)/);
  const one = selfModel({ runs: [oldRun('r1', [unit('u1', 'pass', ['pass'])])], lessons: { global: [{ id: 'l1', tag: 'code', text: 't', seen: 1, used: 0 }] } });
  const page1 = selfPage(one, Date.now(), staticCtx('', 0));
  assert.match(page1, /1 lesson ·/); assert.match(page1, /across 1 run in/); assert.match(page1, /1 of 1 unit finished/);
  assert.match(page1, /Counted over 1 finished unit in all runs, open included\. No closed run yet/);
  const t = selfText(one);
  assert.match(t, /1 run \(1 open\) · 1 unit ·/); assert.match(t, /1 lesson ·/); assert.match(t, /1 finished unit \(all runs/);
});

test('the page: one keyed section per SECTIONS entry; state text escaped; COORDINATOR.md code spans', () => {
  const r = oldRun('r1', [unit('u1', 'pass', ['pass'])], { outcome: 'done', decision: 'done', at: at(60) });
  r.notes.push({ kind: 'follow-up', text: '<script>alert(1)</script> see https://example.com/x', at: at(10) });
  const html = selfPage(selfModel({ runs: [r], context: '## Checks\n- `npm test` <b>x</b>\n' }), Date.now(), { ...staticCtx('', 0), runHref: (id) => `runs/${id}/hud.html` });
  for (const s of SECTIONS) assert.match(html, new RegExp(`data-k="self-${s.id}"`));
  assert.doesNotMatch(html, /<script>alert/); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>npm test<\/code> &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /href="runs\/r1\/hud\.html"/);
  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">/);
  assert.equal(parseContext('intro only').length, 0);
});

test('cli: study needs sources, keeps to the per-run cap; lessons take --source; retro notes after close; self prints', () => {
  assert.equal(run('init', 's1', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--study-budget', '1').code, 0);
  assert.equal(state('s1').budget.maxStudies, 1);
  assert.equal(run('init', 's2', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--study-budget', '11').code, 1);
  assert.match(run('study', 's1', '--topic', 't', '--text', 'x').err, /at least one --source/);
  assert.match(run('study', 's1', '--topic', 't', '--text', 'x', '--source', 'javascript:alert(1)').err, /http\(s\) URL/);
  assert.match(run('study', 's1', '--topic', 't', '--text', 'x', '--area', 'magic', '--source', 'https://a.example').err, /--area must be one of/);
  const ok = run('study', 's1', '--topic', 'CSP nonces', '--area', 'security', '--text', 'one nonce per response', '--source', 'https://a.example/csp', '--source', 'https://b.example', '--lesson', 'abc123');
  assert.equal(ok.code, 0); assert.equal(ok.out.study, 'S1');
  assert.deepEqual(state('s1').studies[0].sources, ['https://a.example/csp', 'https://b.example/']);
  assert.match(run('study', 's1', '--topic', 't', '--text', 'x', '--source', 'https://a.example').err, /study budget spent \(1\/1\)/);

  let l = cli('lessons.mjs', 'add', '--tag', 'design', '--text', 'Focus rings stay visible in dark mode', '--source', 'https://w3.example/focus', '--from', 's1');
  assert.equal(l.code, 0);
  cli('lessons.mjs', 'add', '--tag', 'design', '--text', 'Focus rings stay visible in dark mode', '--source', 'https://w3.example/other');
  l = cli('lessons.mjs', 'list', '--tag', 'design').out[0];
  assert.deepEqual(l.sources, ['https://w3.example/focus', 'https://w3.example/other']); assert.equal(l.seen, 2); assert.deepEqual(l.from, ['s1']);
  assert.equal(cli('lessons.mjs', 'add', '--text', 'x y z', '--source', 'ftp://x').code, 1);

  run('add', 's1', 'u1', '--bar', 'b'); run('freeze', 's1');
  run('close', 's1', '--outcome', 'stopped', '--reason', 'test');
  assert.equal(run('note', 's1', '--kind', 'retro', '--text', 'upstream: stale check too eager').code, 0, 'retro notes are allowed after close');
  const t = run('self');
  assert.equal(t.code, 0);
  assert.match(t.raw, /1 study/); assert.match(t.raw, /\[upstream\] upstream: stale check too eager/); assert.match(t.raw, /\[design\]/);
  const js = run('self', '--json').out;
  assert.equal(js.study.log[0].topic, 'CSP nonces');
  const st = run('stats').out;
  assert.equal(js.stats.closed.units, st.units, 'the closed-runs figure is the one run.mjs stats prints');
  assert.equal(js.stats.closed.stoppedShare, Math.round(st.stoppedShare * 100));
  const f = run('self', '--html').out.file;
  assert.ok(existsSync(f)); assert.match(readFileSync(f, 'utf8'), /Side study/);
  assert.equal(run('self', '--json', '--html').code, 1);
});

test('serve: /coordinator and /run/<other> need the token; other runs are read-only; the header links the pages; live across runs', async () => {
  for (const r of ['w1', 'w2']) { run('init', r, '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', r, 'u1', '--bar', 'b'); run('freeze', r); }
  run('ask', 'w2', '--question', 'Ship?', '--header', 'Ship', '--option', 'Yes|now', '--option', 'No|later');
  writeFileSync(join(dir, 'state', 'runs', 'broken'), 'not a folder');
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'w1', '--port', '0'], { env, cwd: dir });
  children.push(c);
  const url = await new Promise((ok) => { let b = ''; c.stdout.on('data', (d) => { b += d; const m = /"url": ?"([^"]+)"/.exec(b); if (m) ok(m[1]); }); });
  const { origin } = new URL(url); const t = new URL(url).searchParams.get('t');
  const get = (p) => new Promise((ok) => httpGet(`${origin}${p}`, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => ok({ status: res.statusCode, body: d })); }));
  assert.equal((await get('/coordinator')).status, 403);
  const self = await get(`/coordinator?t=${t}`);
  assert.equal(self.status, 200);
  assert.match(self.body, /<a href="\/coordinator\?t=[^"]+" aria-current="page">Coordinator<\/a>/);
  assert.match(self.body, /<a href="\/run\/w2\?t=/); assert.match(self.body, /data-path="\/coordinator"/);
  const home = (await get(`/?t=${t}`)).body;
  assert.match(home, /<nav class="pages" aria-label="Pages"><a href="\/\?t=[^"]+" aria-current="page">w1<\/a><a href="\/maps\?t=[^"]+">Maps<\/a><a href="\/coordinator\?t=/);
  const other = await get(`/run/w2?t=${t}`);
  assert.equal(other.status, 200);
  assert.doesNotMatch(other.body, /<form class="(ask|note)"/, 'no forms on another run');
  assert.match(other.body, /Ship\?/); assert.match(other.body, /data-path="\/run\/w2"/); assert.match(other.body, /href="\/run\/w2\/unit\/u1\?t=/);
  assert.equal((await get(`/run/w2/unit/u1?t=${t}`)).status, 200);
  assert.match((await get(`/?t=${t}`)).body, /<form class="note"/, 'the served run keeps its forms');
  for (const p of ['/run/nope', '/run/a..b', '/run/a..b/unit/u1', '/run/w2/unit/nope', '/run/broken', '/coordinator/x']) assert.equal((await get(`${p}?t=${t}`)).status, 404, p);
  const frames = [];
  const stream = await new Promise((ok) => httpGet(`${origin}/events?t=${t}&p=/coordinator`, (res) => { res.setEncoding('utf8'); res.on('data', (d) => frames.push(d)); ok(res); }));
  const until = async (re) => { for (let i = 0; i < 80; i++) { if (re.test(frames.join(''))) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`no frame matching ${re}`); };
  await until(/event: patch/);
  run('note', 'w2', '--kind', 'follow-up', '--text', 'A change in another run arrives live');
  await until(/A change in another run arrives live/);
  stream.destroy();
});
