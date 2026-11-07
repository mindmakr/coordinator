// Is the run finished, and how near? The status word, progress maths, ETA, status line and
// closing line (lib/progress.mjs), and that show, list, status-line, the HUD and the
// coordinator page all say the same thing, old runs included.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../lib/rules.mjs';
import { hud } from '../lib/hud.mjs';
import { selfModel, selfText } from '../lib/self.mjs';
import { selfPage } from '../lib/selfpage.mjs';
import { staticCtx } from '../lib/hud.mjs';
import { text, view } from '../lib/view.mjs';
import { clock, freeAt, ordered, runStatus } from '../lib/progress.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coordinator-progress-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const T0 = Date.parse('2026-01-01T18:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const pass = (n, min) => ({ n, verdict: 'pass', score: 9, gap: null, evidence: 'green', at: at(min) });
const fail = (n, min) => ({ n, verdict: 'fail', score: 4, gap: 'off by one', cause: 'dates', evidence: 'red', at: at(min) });
const unit = (id, extra = {}) => ({ id, bar: `${id} works`, after: null, status: 'open', strategyChanges: 0, strategyAt: -1, heartbeatAt: null, rounds: [], ...extra });
const state = (extra = {}) => ({
  id: 'payday-x', tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [],
  budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
  createdAt: at(0), frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null, notes: [],
  units: [
    unit('u1', { status: 'pass', title: 'Totals', rounds: [pass(1, 20)] }),
    unit('u2', { status: 'pass', title: 'Dates', rounds: [fail(1, 15), pass(2, 40)] }),
    unit('u3', { status: 'building', heartbeatAt: at(44), rounds: [fail(1, 30)] }),
    unit('u4', { after: 'u3' }),
  ],
  ...extra,
});
const NOW = T0 + 45 * 60_000;
const st = (s, now = NOW) => runStatus(s, decide(s, now), { nowMs: now, timeZone: 'UTC' });

test('the status word: running, waiting on you, finishing, concluded with its reason', () => {
  assert.equal(st(state()).word, 'Running');
  assert.equal(st(state()).kind, 'running');
  // An open question, or a finish-line ask not yet asked, is waiting on you.
  const asked = st(state({ notes: [{ kind: 'question', text: 'Which zone?', unit: 'u3', at: at(10) }] }));
  assert.equal(asked.word, 'Waiting on you');
  assert.deepEqual(asked.needsYou.map((q) => q.id), ['q1']);
  const finish = state();
  finish.units = [unit('u1', { status: 'pass', rounds: [pass(1, 20)] }), unit('u2', { rounds: [fail(1, 20), { ...fail(2, 30), severity: 'medium' }] })];
  const plan = decide(finish, NOW);
  if (plan.units.some((u) => u.action === 'ask-person')) assert.equal(runStatus(finish, plan, { nowMs: NOW }).word, 'Waiting on you');
  // Every unit decided, the integration check still to run: finishing.
  const fin = state(); fin.units = fin.units.slice(0, 2);
  const f = st(fin);
  assert.equal(f.word, 'Finishing');
  assert.equal(f.doing, 'integration check next');
  // Closed: Concluded, with a reason and what it delivered.
  const done = st(state({ closed: { outcome: 'done', at: at(90) }, units: fin.units }));
  assert.equal(done.word, 'Concluded: done');
  assert.ok(done.concluded);
  assert.match(done.reason, /goal is met: 2 of 2 units passed/);
  assert.deepEqual(done.delivered, ['u1 Totals', 'u2 Dates']);
  const partial = st(state({ closed: { outcome: 'partial', at: at(90) }, units: [...fin.units, unit('u3', { status: 'stopped', stopReason: 'budget: rounds', rounds: [fail(1, 30)] })] }));
  assert.equal(partial.word, 'Concluded: partial');
  assert.match(partial.reason, /2 of 3 units passed, 1 stopped/);
  const early = st(state({ closed: { outcome: 'stopped', at: at(90) }, notes: [{ kind: 'decision', text: 'closed early as stopped at "continue": the person called it off', at: at(89) }] }));
  assert.equal(early.word, 'Concluded: stopped');
  assert.equal(early.reason, 'the person called it off');
  // Not frozen yet: running, planning units.
  assert.equal(st(state({ frozen: false, units: [unit('a')] })).doing, 'planning units');
});

test('progress: decided units out of total, a percentage, and the round in progress', () => {
  const s = st(state());
  assert.deepEqual([s.done, s.total, s.pct, s.stopped], [2, 4, 50, 0]);
  assert.equal(s.progress, '2 of 4 units done (50%)');
  assert.deepEqual(s.current, [{ id: 'u3', phase: 'building', round: 2 }]);
  assert.equal(s.doing, 'building u3 round 2');
  const thirds = state(); thirds.units = [thirds.units[0], unit('a'), { ...unit('b'), status: 'stopped', stopReason: 'x', rounds: [fail(1, 5)] }];
  const t = st(thirds);
  assert.equal(t.pct, 67);
  assert.equal(t.progress, '2 of 3 units done (67%), 1 stopped');
  const none = state(); none.units = [];
  assert.equal(st(none).pct, 0);
  assert.equal(st(none).progress, '0 of 0 units done (0%)');
  const one = state(); one.units = [unit('only', { status: 'judging', rounds: [] })];
  assert.equal(st(one).doing, 'checking only round 1');
  assert.equal(st(one).progress, '0 of 1 unit done (0%)');
});

test('the ETA in plain words: time left and a local ready time, or no estimate yet', () => {
  const s = st(state());
  // Tries took 20, 15, 25 and 30 min (median 20); u3 then u4 then the integration check: 3 tries.
  assert.equal(s.eta.minutes, 60);
  assert.equal(s.eta.text, 'about 1 h left; ready around 19:45 local time');
  assert.equal(s.eta.short, 'about 1 h left (~19:45)');
  assert.equal(s.eta.readyAt, at(105));
  const fresh = state(); fresh.units = [unit('a', { status: 'building' })];
  assert.equal(st(fresh).eta.text, 'no estimate yet');
  assert.equal(st(fresh).eta.readyAt, null);
  // An estimate past the time budget stops at the budget.
  const late = st(state(), T0 + 220 * 60_000);
  assert.ok(late.eta.capped);
  assert.match(late.eta.text, /^about 20 min left, when the time budget runs out; ready around 22:00 local time$/);
  assert.equal(st(state(), T0 + 300 * 60_000).eta.text, 'the time budget is spent');
  assert.equal(st(state({ closed: { outcome: 'done', at: at(90) } })).eta.text, 'finished');
  // Another day names the weekday.
  assert.equal(clock(Date.parse('2026-01-02T09:10:00Z'), Date.parse('2026-01-01T23:00:00Z'), 'UTC'), 'Fri 09:10');
});

test('status-line and the closing line say it one way', () => {
  assert.equal(st(state()).line, 'payday-x · Running: 2 of 4 units done (50%), building u3 round 2, about 1 h left (~19:45). Nothing needs you.');
  const q = st(state({ notes: [{ kind: 'question', text: 'Which zone?', unit: 'u4', at: at(10) }] }));
  assert.equal(q.line, 'payday-x · Waiting on you: 2 of 4 units done (50%), building u3 round 2, about 1 h left (~19:45). Needs you: q1.');
  const closed = state({ closed: { outcome: 'partial', at: at(90) }, notes: [{ kind: 'follow-up', text: 'u4 dates in the export', unit: 'u4', at: at(80) }] });
  const c = st(closed);
  assert.match(c.line, /^payday-x concluded: partial\. Delivered: u1 Totals; u2 Dates\. Follow-ups: \d+ in Gaps\. Ready for the next run\.$/);
  assert.ok(c.followUps >= 1);
});

test('active runs first, newest first; then the recently concluded; when the machine frees up', () => {
  const a = state({ id: 'a', createdAt: at(0) }); const b = state({ id: 'b', createdAt: at(5) });
  const c = state({ id: 'c', closed: { outcome: 'done', at: at(60) } }); const d = state({ id: 'd', closed: { outcome: 'stopped', at: at(70) } });
  const runs = [a, b, c, d];
  const o = ordered(runs.map((r) => st(r)), runs);
  assert.deepEqual(o.active.map((x) => x.run), ['b', 'a']);
  assert.deepEqual(o.concluded.map((x) => x.run), ['d', 'c']);
  const free = freeAt(o.active);
  assert.equal(free.at, o.active.map((x) => x.eta.readyAt).sort().at(-1));
});

test('show, the HUD, the coordinator page and its text agree with runStatus', () => {
  const open = state({ notes: [{ kind: 'question', text: 'Which zone?', unit: 'u4', at: at(10) }] });
  const ended = state({ id: 'old', createdAt: at(-500), closed: { outcome: 'done', at: at(-300) }, units: state().units.slice(0, 2) });
  const runs = [open, ended];
  const direct = new Map(runs.map((r) => [r.id, runStatus(r, decide(r, NOW), { nowMs: NOW, runs })]));
  const m = selfModel({ runs, nowMs: NOW });
  const page = selfPage(m, NOW, { ...staticCtx(null, 0), runHref: (id) => `runs/${id}/hud.html` });
  const txt = selfText(m);
  for (const r of runs) {
    const want = direct.get(r.id);
    const v = view(r, decide(r, NOW), NOW);
    for (const k of ['word', 'progress', 'doing', 'line', 'pct']) assert.deepEqual(v.status[k], want[k], `${r.id} view ${k}`);
    assert.deepEqual(v.status.eta, want.eta);
    const fromSelf = [...m.active.runs, ...m.active.concluded].find((x) => x.run === r.id);
    assert.equal(fromSelf.line, want.line, `${r.id} coordinator page`);
    assert.ok(txt.includes(want.line), `${r.id} self text`);
    assert.ok(page.includes(want.word), `${r.id} page word`);
    const html = hud(v, NOW);
    assert.ok(html.includes(`>${want.word}<`), `${r.id} hud chip`);
    assert.ok(html.includes(want.progress), `${r.id} hud progress`);
    const show = text(v);
    assert.match(show, new RegExp(`^${r.id} \\[code\\] · ${want.word}`));
    assert.ok(show.includes(want.progress));
  }
  // The concluded banner says it is finished and what it delivered; the running one gives its ETA.
  assert.match(hud(view(ended, decide(ended, NOW), NOW), NOW), /This run is finished\.<\/b>.*Delivered:<\/b> u1 Totals; u2 Dates/s);
  assert.match(hud(view(open, decide(open, NOW), NOW), NOW), /About 1 h left; ready around \d\d:\d\d local time\./);
  assert.match(page, /id="self-active"/);
  assert.ok(page.indexOf('id="self-active"') < page.indexOf('id="self-age"'), 'Active runs is the first section');
  assert.match(page, /1 run active/);
});

const cli = (dir, ...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });

test('the CLI: list, status-line (one run and all), show and self print the same line', () => {
  const dir = join(tmp, 'cli');
  const ok = (...a) => { const r = cli(dir, ...a); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout; };
  ok('init', 'r1', '--goal', 'fix totals', '--bar', 'red test green', '--fence', 'backend/', '--tag', 'code');
  ok('add', 'r1', 'api', '--bar', 'totals test passes', '--title', 'Totals'); ok('add', 'r1', 'ui', '--bar', 'page shows totals');
  ok('freeze', 'r1'); ok('next', 'r1'); ok('start', 'r1', 'api');
  ok('init', 'r2', '--goal', 'docs', '--bar', 'a page', '--fence', 'docs/', '--tag', 'docs');
  ok('add', 'r2', 'd1', '--bar', 'page exists'); ok('freeze', 'r2'); ok('next', 'r2');
  ok('note', 'r2', '--kind', 'decision', '--text', 'skip');
  const one = ok('status-line', 'r1').trim();
  assert.equal(one, 'r1 · Running: 0 of 2 units done (0%), building api round 1, no estimate yet. Nothing needs you.');
  const list = JSON.parse(ok('list'));
  const r1 = list.find((r) => r.run === 'r1');
  assert.equal(r1.line, one);
  assert.equal(r1.status, 'Running');
  assert.deepEqual(r1.progress, { done: 0, total: 2, pct: 0, stopped: 0 });
  assert.equal(r1.eta, 'no estimate yet');
  const all = ok('status-line').trim().split('\n');
  assert.ok(all.includes(one));
  assert.equal(all.length, 2);
  const show = ok('show', 'r1');
  assert.match(show, /^r1 \[code\] · Running/);
  assert.match(show, /^progress {3}0 of 2 units done \(0%\) · building api round 1$/m);
  assert.match(show, /^eta {8}no estimate yet$/m);
  assert.ok(ok('self').includes(one));
  const json = JSON.parse(ok('status-line', 'r1', '--json'));
  assert.equal(json[0].line, one);
});

test('old runs: every release\'s state folder gives a status line', () => {
  const fixtures = join(scripts, 'test', 'fixtures', 'old-runs');
  for (const v of readdirSync(fixtures).filter((x) => x.startsWith('v'))) {
    const dir = join(tmp, `old-${v}`);
    cpSync(join(fixtures, v), dir, { recursive: true });
    const r = cli(dir, 'status-line');
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
    const lines = r.stdout.trim().split('\n');
    assert.ok(lines.some((l) => / concluded: \w+\. Delivered: /.test(l)), `${v}: the closed run has a closing line`);
    assert.ok(lines.some((l) => /^old-open · (Running|Waiting on you|Finishing): \d+ of \d+ units? done \(\d+%\)/.test(l)), `${v}: the open run has a status line`);
    assert.equal(readFileSync(join(fixtures, v, 'runs', 'old-open', 'state.json'), 'utf8').length > 0, true);
  }
});
