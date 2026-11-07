import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hud } from '../lib/hud.mjs';
import { decide } from '../lib/rules.mjs';
import { text, view } from '../lib/view.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const state = (extra = {}) => ({
  id: 'r1', tag: 'code', goal: 'fix totals', bar: 'red test green', fence: 'backend/', paths: [],
  budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
  createdAt: at(0), frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null,
  units: [
    { id: 'api', bar: 'b', after: null, status: 'open', strategyChanges: 0, strategyAt: -1, rounds: [
      { n: 1, verdict: 'fail', score: 3, gap: '<script>alert(1)</script> totals off', cause: 'cycle "dates"', evidence: 'e', at: at(10) },
      { n: 2, verdict: 'fail', score: 5.5, gap: 'still off', evidence: 'e', at: at(20) },
    ] },
    { id: 'ui', bar: 'b', after: 'api', status: 'open', strategyChanges: 0, strategyAt: -1, rounds: [] },
  ],
  notes: [
    { kind: 'decision', text: 'merge when READY', at: at(1) },
    { kind: 'question', text: 'chose UTC </li><img src=x onerror=alert(2)>', at: at(15) },
    { kind: 'follow-up', text: 'flaky test in billing', at: at(21) },
  ],
  ...extra,
});

test('the text view shows units, score trend, budget with time, and the next step', () => {
  const s = state();
  const out = text(view(s, decide(s, T0 + 30 * 60_000), T0 + 30 * 60_000));
  assert.match(out, /^r1 \[code\] · Waiting on you/); assert.match(out, /^phase {6}continue$/m);
  assert.match(out, /time 30\/240 min/);
  assert.match(out, /units 2\/6/);
  assert.match(out, /api\s+open\s+2\/4\s+3 → 5\.5\s+build/);
  assert.match(out, /ui\s+open\s+0\/4\s+–\s+wait: after api/);
  assert.match(out, /next {4}build api/);
  assert.match(out, /1 questions · 1 follow-ups · 1 decisions/);
});

test('a closed run counts time to its close, not to now', () => {
  const s = state({ closed: { outcome: 'partial', decision: 'continue', at: at(90) } });
  const v = view(s, decide(s, T0 + 999 * 60_000), T0 + 999 * 60_000);
  assert.equal(v.budget[0].used, 90);
  assert.equal(v.next, 'nothing: closed as partial');
  assert.doesNotMatch(hud(v), /http-equiv="refresh"/, 'a closed run stops refreshing');
});

test('hud.html escapes every piece of state text and loads nothing', () => {
  const s = state({ goal: 'g {{units}} & "q"' });
  const html = hud(view(s, decide(s, T0), T0), T0);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /cause: cycle &quot;dates&quot;/);
  assert.match(html, /g \{\{units\}\} &amp; &quot;q&quot;/, 'placeholders inside state text are not expanded');
  assert.doesNotMatch(html, /\bsrc=["']?(https?:)?\/\//i, 'no network');
  assert.doesNotMatch(html, /<link rel="stylesheet"|@import/i, 'no stylesheets from anywhere');
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /http-equiv="refresh"/, 'a snapshot: no reload that would close what the reader opened');
  assert.match(html, /<svg class="spark"[^>]*>.*<polyline points="/s);
  assert.deepEqual([...new Set(html.match(/\{\{\w+\}\}/g))], ['{{units}}'], 'every placeholder filled; only the goal\'s text remains');
});

test('an old state without causes or notes still renders', () => {
  const s = state({ notes: undefined });
  for (const u of s.units) for (const r of u.rounds) delete r.cause;
  const v = view(s, decide(s, T0), T0);
  assert.equal(v.units[0].cause, null);
  assert.match(hud(v), /No units yet|api/);
});

test('a hosted read-only copy can name its own answer hint and mark evidence files as kept locally', async () => {
  const { staticCtx } = await import('../lib/hud.mjs');
  const { unitPage } = await import('../lib/unitpage.mjs');
  const s = state();
  s.units[0].evidence = [{ id: 'e1', kind: 'log', label: 'test log', file: 'api/run <1>.log', at: at(11) }];
  const { ask } = await import('../lib/questions.mjs');
  ask(s, { question: 'which?', header: 'Which', option: ['a|first', 'b|second'] }); // an open question shows the hint
  const v = view(s, decide(s, T0), T0);
  const ctx = { ...staticCtx('', 0), readOnlyHint: 'Answer in the chat for now <b>', artHref: () => null };
  const page = hud(v, T0, ctx);
  assert.match(page, /Answer in the chat for now &lt;b&gt;/);
  assert.equal(page.includes('run.mjs serve'), false);
  const unit = unitPage(v, 'api', T0, ctx);
  assert.match(unit, /run &lt;1&gt;\.log: file kept locally/);
  assert.equal(/href="null"|href=""/.test(unit), false, 'no broken link');
  // The local snapshot still links its files and keeps its own hint.
  assert.match(unitPage(v, 'api', T0, staticCtx('', 1)), /href="\.\.\/artifacts\/api\/run%20%3C1%3E\.log"/);
  assert.match(hud(v, T0, staticCtx('', 0)), /run\.mjs serve r1/);
});

test('a unit waiting on another says so in words, links it, and the other says what it blocks', async () => {
  const { staticCtx, liveCtx } = await import('../lib/hud.mjs');
  const { unitPage } = await import('../lib/unitpage.mjs');
  const s = state();
  const v = view(s, decide(s, T0), T0);
  const ui = v.units.find((u) => u.id === 'ui'); const api = v.units.find((u) => u.id === 'api');
  assert.equal(ui.dot, 'blocked'); assert.deepEqual(ui.badge, { kind: 'blocked', lead: 'Waiting for ', label: 'Waiting for api', ids: ['api'], title: 'waiting for another unit' });
  assert.equal(api.dot, 'retrying'); assert.equal(api.badge.label, 'Retrying'); assert.equal(api.badge.title, 'The lead is on it: failed twice in a row');
  assert.deepEqual(api.dependents.map((x) => [x.id, x.dot]), [['ui', 'blocked']]);
  const html = hud(v, T0, staticCtx('', 0));
  const card = html.slice(html.indexOf('id="unit-ui"'), html.indexOf('</section>', html.indexOf('id="unit-ui"')));
  assert.match(card, /<span class="chip s-blocked"[^>]*>Waiting for <a class="ulink" href="units\/api\.html">api<\/a><\/span>/);
  assert.match(card, /aria-label="waiting for api"/);
  assert.match(card, /Waiting for <a class="ulink" href="units\/api\.html">api<\/a>; starts when it passes\./);
  assert.match(card, /<b>Next:<\/b> wait: after <a class="ulink" href="units\/api\.html">api<\/a>/);
  assert.doesNotMatch(card, /chip s-open/, 'the bare "open" chip is replaced by the state in words');
  assert.match(html, /<p class="cause blocks" data-a="blocks-api"><b>Blocks:<\/b> <a class="ulink" href="units\/ui\.html">ui<\/a><\/p>/);
  assert.match(html, /<b>Needs you<\/b> = only you can unblock it;.*<b>Waiting for A<\/b> = blocked on another unit.*<b>Up next<\/b> = ready, not started/s);
  // Live: the token stays on the link; another run's page links under /run/<id>.
  assert.match(hud(v, T0, liveCtx({ token: 'to&k', nonce: 'n' }, 'r1')), /href="\/unit\/api\?t=to%26k">api<\/a>; starts/);
  assert.match(hud(v, T0, liveCtx({ token: 'k', nonce: 'n' }, 'r0', null, 'r1')), /href="\/run\/r1\/unit\/api\?t=k">api<\/a>/);
  // The unit page: the same links, and Depends on / Blocks with each unit's dot and badge.
  const page = unitPage(v, 'ui', T0, staticCtx('', 1));
  assert.match(page, /Depends on \/ Blocks/);
  assert.match(page, /<li data-a="dep-api"><span class="dot dot-retrying"[^>]*><\/span> <a class="ulink" href="\.\.\/units\/api\.html">api<\/a> <span class="chip flag" title="The lead is on it: failed twice in a row">Retrying<\/span><\/li>/);
  assert.match(page, /<span class="chip s-blocked"[^>]*>Waiting for <a class="ulink" href="\.\.\/units\/api\.html">api<\/a>/);
  assert.match(unitPage(v, 'api', T0, staticCtx('', 1)), /<h3 class="sub">Blocks<\/h3><ul class="deps"><li data-a="dep-ui"><span class="dot dot-blocked"/);
});

test('queued says Up next; an open question on a unit says Needs you, and only it takes the needs-you colour', () => {
  const s = state();
  s.units[0].rounds = []; // api: ready, not started
  s.notes.push({ kind: 'question', text: 'which zone?', unit: 'ui', options: [], at: at(16) });
  const v = view(s, decide(s, T0), T0);
  const [api, ui] = v.units;
  assert.equal(api.dot, 'queued'); assert.equal(api.badge.label, 'Up next');
  assert.equal(ui.dot, 'needs-you'); assert.equal(ui.badge.label, 'Needs you · waiting for api', 'blocked and asked: both, the person first');
  const html = hud(v, T0);
  assert.match(html, /<span class="chip s-queued"[^>]*>Up next<\/span>/);
  assert.match(html, /<span class="chip s-needs-you"[^>]*>Needs you · waiting for <a class="ulink" href="units\/api\.html">api<\/a><\/span>/);
  assert.match(html, /aria-label="needs you: only you can unblock it; waiting for api"/);
  assert.match(html, /<b>Blocks:<\/b> <a class="ulink" href="units\/ui\.html">ui<\/a>/, 'a dependent that also needs you still shows under Blocks');
  const css = html.slice(html.lastIndexOf('<style>'), html.lastIndexOf('</style>'));
  for (const sel of ['.dot-retrying', '.dot-queued', '.dot-blocked', '.flag', '.s-queued', '.s-blocked']) {
    const rule = css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    assert.ok(rule && !/var\(--wait\)/.test(rule), `${sel} must not use the needs-you colour`);
  }
  assert.match(css, /\.dot-needs-you \{ background: var\(--wait\)/);
});

test('an old run without after, titles or notes still renders its units', async () => {
  const { unitPage } = await import('../lib/unitpage.mjs');
  const s = state({ notes: undefined });
  for (const u of s.units) delete u.after;
  s.units.push({ id: 'gone', bar: 'b', after: 'missing', status: 'open', rounds: [] });
  const v = view(s, decide(s, T0), T0);
  assert.deepEqual(v.units.map((u) => u.dot), ['retrying', 'queued', 'queued'], 'a unit after a missing one is not held (lib/rules.mjs)');
  assert.deepEqual(v.units[2].dependsOn, [{ id: 'missing', title: null, status: null, dot: null, badge: null }]);
  assert.doesNotMatch(hud(v, T0), /class="chip s-blocked"|<b>Blocks:<\/b>/);
  assert.match(unitPage(v, 'gone', T0), /<li data-a="dep-missing">missing <span class="cause">not in this run<\/span><\/li>/);
});

test('every state has words: in chips, unit page, Depends on rows, map tooltips and the self page', async () => {
  const { staticCtx, liveCtx } = await import('../lib/hud.mjs');
  const { unitPage } = await import('../lib/unitpage.mjs');
  const { mapsPage } = await import('../lib/mapspage.mjs');
  const { selfModel } = await import('../lib/self.mjs');
  const { selfPage } = await import('../lib/selfpage.mjs');
  const s = state();
  s.units[0].id = 'Api'; s.units[1].after = 'Api';
  s.units.push({ id: 'run', bar: 'b', after: null, status: 'building', heartbeatAt: at(29), rounds: [] });
  s.units.push({ id: 'ok', bar: 'b', after: null, status: 'pass', rounds: [{ n: 1, verdict: 'pass', score: 9, at: at(5) }] });
  s.units.push({ id: 'quiet', bar: 'b', after: null, status: 'building', heartbeatAt: at(0), rounds: [] });
  const now = T0 + 60 * 60_000;
  const v = view(s, decide(s, now), now);
  assert.deepEqual(v.units.map((u) => [u.id, u.badge.label]), [['Api', 'Retrying'], ['ui', 'Waiting for Api'], ['run', 'Working'], ['ok', 'Passed'], ['quiet', 'Quiet']]);
  const html = hud(v, now);
  for (const w of ['Retrying', 'Working', 'Passed', 'Quiet']) assert.match(html, new RegExp(`<span class="chip [^"]+"[^>]*>${w}</span>`), w);
  assert.doesNotMatch(html.slice(html.indexOf('data-k="units"')), /<span class="chip s-(open|building|pass)">/, 'no raw status chip on a card');
  assert.match(html, /aria-label="waiting for Api"/, 'ids keep their case');
  const api = unitPage(v, 'Api', now, staticCtx('', 1));
  assert.match(api, /<h1><span class="dot dot-retrying"[^>]*><\/span> Api<\/h1><span class="chip flag"[^>]*>Retrying<\/span>/);
  assert.match(unitPage(v, 'quiet', now), /<span class="chip flag" title="The lead is on it: no word from its agent for a while">Quiet<\/span>/);
  // Map tooltips use the same words, not "open · waiting…".
  const maps = mapsPage(v, now, liveCtx({ token: 'k', nonce: 'n' }, 'r1'));
  assert.match(maps, /ui: Waiting for Api/); assert.match(maps, /Api: Retrying/);
  assert.doesNotMatch(maps, /open · /);
  // Self page: the badge links the unit waited for, in that run (snapshot, live, another run).
  const run = { ...s, units: s.units.map((u) => ({ ...u, specialists: [] })) };
  const m = selfModel({ runs: [run], nowMs: now, current: null });
  const left = m.plans[0].left.find((u) => u.id === 'ui');
  assert.equal(left.badge.label, 'Waiting for Api');
  const snap = selfPage(m, now, { ...staticCtx(null, 0), runHref: (id) => `runs/${id}/hud.html` });
  assert.match(snap, /Waiting for <a class="ulink" href="runs\/r1\/units\/Api\.html">Api<\/a>/);
  assert.match(selfPage(m, now, liveCtx({ token: 'k', nonce: 'n' }, 'r1')), /Waiting for <a class="ulink" href="\/unit\/Api\?t=k">Api<\/a>/);
  assert.match(selfPage(m, now, liveCtx({ token: 'k', nonce: 'n' }, 'other')), /Waiting for <a class="ulink" href="\/run\/r1\/unit\/Api\?t=k">Api<\/a>/);
});
