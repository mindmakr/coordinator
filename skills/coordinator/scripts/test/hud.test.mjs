import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hud, scoreChart } from '../lib/hud.mjs';
import { unitPage } from '../lib/unitpage.mjs';
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
  // The question asked at minute 15 is still open: the clock pauses from then (lib/clock.mjs).
  assert.match(out, /time 15\/240 min \(15 min paused while the person decided and no unit was at work\)/);
  assert.match(out, /units 2\/6/);
  assert.match(out, /api\s+open\s+2\/4\s+3 → 5\.5\s+build/);
  assert.match(out, /ui\s+open\s+0\/4\s+–\s+wait: after api/);
  assert.match(out, /next {4}build api/);
  assert.match(out, /1 questions · 1 follow-ups · 1 decisions/);
});

test('a closed run counts time to its close, not to now', () => {
  // The question asked at minute 15 was answered at minute 20: 5 paused minutes, so the close
  // (90 - 5 = 85) and now (999 - 5) give different counts.
  const answered = state().notes.map((n) => (n.kind === 'question' ? { ...n, history: [{ choices: ['A'], other: null, by: 'person', via: 'dashboard', at: at(20) }] } : n));
  const s = state({ closed: { outcome: 'partial', decision: 'continue', at: at(90) }, notes: answered });
  const v = view(s, decide(s, T0 + 999 * 60_000), T0 + 999 * 60_000);
  assert.equal(v.budget[0].used, 85, '90 minutes to the close, less the 5 the question stayed open');
  // A closed run with no question: the full 90 minutes to the close.
  const plain = state({ closed: { outcome: 'partial', decision: 'continue', at: at(90) }, notes: [] });
  assert.equal(view(plain, decide(plain, T0 + 999 * 60_000), T0 + 999 * 60_000).budget[0].used, 90);
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
  assert.match(html, /<span class="mono">3 → 5\.5<\/span>/, 'the scores per try, as a trend on the run page');
  assert.match(unitPage(view(s, decide(s, T0), T0), 'api', T0), /<svg class="spark"[^>]*>.*<polyline points="/s, 'and as a chart on the unit page');
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
  const card = html.slice(html.indexOf('id="unit-ui"'), html.indexOf('</tr>', html.indexOf('id="unit-ui"')));
  assert.match(card, /<span class="chip s-blocked"[^>]*>Waiting for <a class="ulink" href="units\/api\.html">api<\/a><\/span>/);
  assert.match(card, /aria-label="waiting for api"/);
  assert.match(card, /Waiting for <a class="ulink" href="units\/api\.html">api<\/a>; starts when it passes\./);
  assert.match(card, /<div data-a="next-ui">wait: after <a class="ulink" href="units\/api\.html">api<\/a>/);
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

test('a try a specialist failed names the specialist in its dot label', () => {
  const html = scoreChart([
    { n: 1, verdict: 'fail', score: 6, gap: 'g' },
    { n: 2, verdict: 'fail', score: 9, failedBy: ['money', 'security'], gap: 'rounds half up', general: 'pass' },
  ]);
  assert.match(html, /<title>Try 1: failed, 6\/10 — g<\/title>/);
  assert.match(html, /<title>Try 2: failed by specialist money, security, 9\/10 — rounds half up<\/title>/);
});

test('a lone try a specialist failed names the specialist too', () => {
  assert.match(scoreChart([{ n: 1, verdict: 'fail', score: 9, failedBy: ['security'], cause: 'leak', general: 'pass' }]), /Failed try 1 by specialist security \(9\/10\) — leak/);
  assert.match(scoreChart([{ n: 1, verdict: 'fail', score: 6, gap: 'g' }]), /Failed try 1 \(6\/10\) — g/);
});

// #147: a round the general critic passed and specialist money failed (#126) has the specialist's gap and the
// general critic's evidence ("review clean"). Last gap must show money's own evidence (pay.ts:40) with money's gap.
test('Last gap of a round a specialist failed shows that specialist\'s evidence, not the general critic\'s (#147)', async () => {
  const { unitPage } = await import('../lib/unitpage.mjs');
  const s = state();
  s.units[0].rounds = [{ n: 1, verdict: 'fail', general: 'pass', score: 9, failedBy: ['money'], gap: 'refund rounds half a cent away', cause: 'refund rounding', severity: 'high', evidence: 'review clean', at: at(10),
    specialists: { money: { verdict: 'fail', gap: 'refund rounds half a cent away', evidence: 'pay.ts:40', severity: 'high' }, screen: { verdict: 'pass', evidence: 'screens ok' } } }];
  const v = view(s, decide(s, T0), T0);
  assert.equal(v.units[0].evidence, 'pay.ts:40');
  const gapCell = (html) => { const i = html.indexOf('data-a="gap-api"'); assert.ok(i > 0, 'a Last gap for api'); return html.slice(i, html.indexOf('</td>', i)); };
  const run = gapCell(hud(v, T0));
  assert.match(run, /refund rounds half a cent away/); assert.match(run, /money/); assert.match(run, /pay\.ts:40/);
  assert.doesNotMatch(run, /review clean/);
  const page = unitPage(v, 'api', T0);
  const last = page.slice(page.indexOf('data-d="last-gap" data-a'), page.indexOf('</details>', page.indexOf('data-d="last-gap" data-a')));
  assert.match(last, /refund rounds half a cent away/); assert.match(last, /money/); assert.match(last, /pay\.ts:40/);
  assert.doesNotMatch(last, /review clean/);
  // Two specialists failed: each one's evidence, named, as the gap names each one's gap.
  s.units[0].rounds[0] = { ...s.units[0].rounds[0], failedBy: ['money', 'screen'], gap: 'money: g1; screen: g2', specialists: { money: { verdict: 'fail', evidence: 'pay.ts:40' }, screen: { verdict: 'fail', evidence: 'shot.png' } } };
  assert.equal(view(s, decide(s, T0), T0).units[0].evidence, 'money: pay.ts:40; screen: shot.png');
});

// Run hud-followups f2. B1: the unit's Time KPI adds up each try's start and end stamps (view.mjs tries, time).
test('unit Time KPI: working time from each try\'s start, built and verdict stamps, the try in progress to now', async () => {
  const { tryTimes, workTime } = await import('../lib/timeline.mjs');
  const s = state();
  // Try 1: start 0, built 41, verdict 65. Try 2: start 70, a crash reset at 80, start 90, built 100, verdict 110.
  // Try 3: start 120, built 130, still being judged at 140.
  s.units[0].rounds = [
    { n: 1, verdict: 'fail', score: 4, gap: 'g1', at: at(65) },
    { n: 2, verdict: 'fail', score: 5, gap: 'g2', at: at(110) },
  ];
  s.units[0].status = 'judging';
  s.units[0].log = [
    { kind: 'start', text: 'try 1', at: at(0) }, { kind: 'beat', text: 'b', at: at(20) }, { kind: 'built', text: 'r', at: at(41) },
    { kind: 'start', text: 'try 2', at: at(70) }, { kind: 'reset', text: 'crash', at: at(80) }, { kind: 'start', text: 'try 2', at: at(90) }, { kind: 'built', text: 'r', at: at(100) },
    { kind: 'start', text: 'try 3', at: at(120) }, { kind: 'built', text: 'r', at: at(130) },
  ];
  const now = T0 + 140 * 60_000;
  const t = tryTimes(s.units[0], now);
  assert.deepEqual(t.map((x) => [x.n, x.minutes, x.build, x.review, x.open]), [[1, 65, 41, 24, false], [2, 30, 10, 10, false], [3, 20, 10, 10, true]]);
  assert.deepEqual(t.map((x) => x.start), [at(0), at(70), at(120)]);
  assert.deepEqual(workTime(t), { minutes: 115, build: 61, review: 44, unstamped: 0, open: true });
  const v = view(s, decide(s, now), now);
  assert.deepEqual(v.units[0].time, workTime(t), 'the view carries the same stamps and total');
  const page = unitPage(v, 'api', now);
  assert.match(page, /<span class="k">Time<\/span><span class="v">1 h 55 min<\/span><span class="s">build 1 h 1 min · review 44 min · try running<\/span>/);
  // The Rounds table shows each try's start, build and review minutes beside its verdict time.
  assert.match(page, /<th scope="col">Started<\/th><th scope="col" class="num">Build<\/th><th scope="col" class="num">Review<\/th><th scope="col">Judged<\/th>/);
  assert.match(page, /data-a="rrow-1"><td>T1<\/td><td><time datetime="2026-01-01T00:00:00\.000Z"[^>]*>[^<]*<\/time><\/td><td class="num">41 min<\/td><td class="num">24 min<\/td>/);
  // A try whose start fell out of the log is not guessed at: a dash, and the KPI says how many.
  s.units[0].log = s.units[0].log.slice(3); s.units[0].status = 'open';
  const v2 = view(s, decide(s, now), now);
  assert.equal(v2.units[0].time.unstamped, 1);
  assert.match(unitPage(v2, 'api', now), /<span class="k">Time<\/span><span class="v">30 min<\/span><span class="s">build 10 min · review 10 min · 1 not stamped<\/span>/);
  // No try yet: a dash.
  assert.match(unitPage(v2, 'ui', now), /<span class="k">Time<\/span><span class="v">–<\/span><span class="s">not started<\/span>/);
});

// B2: a long run's Activity scrolls inside its panel; the search and filters stay above the list.
test('Activity has a height limit and scrolls inside itself, below its search and filters', async () => {
  const { liveCtx } = await import('../lib/hud.mjs');
  const s = state({ notes: Array.from({ length: 250 }, (_, i) => ({ kind: 'decision', text: `step ${i}`, at: at(i) })) });
  const v = view(s, decide(s, T0), T0);
  const live = hud(v, T0, liveCtx({ token: 't', nonce: 'n' }, 'r1'));
  for (const html of [hud(v, T0), live]) {
    const i = html.indexOf('data-d="activity"');
    const p = html.slice(i, html.indexOf('</details>', i));
    assert.match(p, /<div class="scroll activity-box" style="max-height:360px"><div class="list-anchor"><ol class="timeline" data-tl-list/);
    assert.ok((p.match(/<li /g) ?? []).length >= 250, 'every row is still there, inside the box');
  }
  { const a = live.indexOf('data-d="activity"'); assert.ok(a < live.indexOf('<form class="tl-tools"', a) && live.indexOf('<form class="tl-tools"', a) < live.indexOf('class="scroll activity-box"', a), 'the filters sit above the scrolling list'); }
  // The unit page's timeline is bounded the same way.
  assert.match(unitPage(v, 'api', T0), /data-d="unit-timeline"[\s\S]*?<div class="scroll activity-box" style="max-height:360px">/);
});

// B3: canvas panels whose data the run records.
test('Run page: ETA and time left as show prints them, Now and ETA on the timeline, pauses hatched', () => {
  const s = state({ notes: [], pauses: [{ from: at(5), to: at(8), reason: 'lunch' }] });
  s.units[0].log = [{ kind: 'start', text: 'try 1', at: at(1) }];
  const now = T0 + 30 * 60_000;
  const v = view(s, decide(s, now), now);
  assert.ok(v.status.eta.readyAt, 'an estimate exists');
  const out = text(v); const html = hud(v, now);
  const etaText = /^eta {8}(.+)$/m.exec(out)[1]; const left = /^time left {2}(.+)$/m.exec(out)[1];
  const kpi = new RegExp(`<span class="k">ETA</span><span class="v"><time datetime="${v.status.eta.readyAt}" class="abs"[^>]*>[^<]+</time></span><span class="s">([^<]+)</span>`).exec(html);
  assert.equal(kpi?.[1], etaText, 'the ETA KPI: the ready time, then show\'s words');
  assert.ok(html.includes(`<span class="cause">Time left</span><span>${left}</span>`), 'the Lead panel says the time left as show does');
  const i = html.indexOf('<div class="lanes">');
  const lanes = html.slice(i, html.indexOf('</details>', i));
  assert.ok(lanes.includes(`<span>ETA <time datetime="${v.status.eta.readyAt}" class="abs"`), 'the axis runs to the ETA');
  assert.match(lanes, /<div class="marks" aria-hidden="true"><span class="held" style="left:[\d.]+%;width:[\d.]+%"><\/span><span class="mark now" style="left:[\d.]+%"><\/span><span class="mark eta" style="left:100\.00%"><\/span><\/div>/);
  assert.match(lanes, /<div class="axis"><span class="now" style="left:[\d.]+%">Now<\/span><\/div>/);
  assert.match(html, /<h2>Timeline<\/h2><span class="meta"><span class="held-key" aria-hidden="true"><\/span>paused<\/span>/);
  // A closed run: no Now, no ETA; the axis ends at the close.
  const ended = { ...s, closed: { outcome: 'partial', at: at(90) } };
  assert.doesNotMatch(hud(view(ended, decide(ended, now), now), now), /class="mark now"|class="mark eta"|>Now</);
});

test('Budget: spend per unit and per agent kind from the recorded launch figures, and each critic setup', () => {
  const s = state();
  s.units[0].costs = [
    { step: 'start', role: 'builder', at: at(1), tokensIn: 300_000, minutes: 40 },
    { step: 'verdict', role: 'critic', at: at(10), tokensIn: 100_000, minutes: 10 },
    { step: 'verdict', role: 'critic:security', at: at(10), tokensIn: 100_000, minutes: 12, cost: { amount: 0.5, currency: 'USD' } },
  ];
  s.units[0].rounds[0].critic = 'general, opus, full depth';
  s.units[0].rounds[1] = { ...s.units[0].rounds[1], critic: 'general, sonnet, delta review', specialists: { security: { verdict: 'fail', critic: 'security, opus' } } };
  const v = view(s, decide(s, T0), T0);
  assert.deepEqual(v.cost.byKind.map((g) => [g.label, g.line, g.share]), [['Builders', '300k in tokens · 40 min', 60], ['General critics', '100k in tokens · 10 min', 20], ['Specialist critics', '100k in tokens · 12 min · 0.5 USD', 20]]);
  assert.deepEqual(v.critics.map((g) => [g.critic, g.setup, g.rounds, g.passed]), [['general', 'general, opus, full depth', 1, 0], ['general', 'general, sonnet, delta review', 1, 0], ['security', 'security, opus', 1, 0]]);
  const html = hud(v, T0);
  assert.match(html, /<li>api: 500k in tokens · 62 min · 0\.5 USD<\/li>/, 'per unit');
  assert.match(html, /<li data-a="cost-builder">Builders: 300k in tokens · 40 min · 60% of tokens in<\/li>/, 'per agent kind');
  assert.match(html, /<li data-a="cost-specialist">Specialist critics: 100k in tokens · 12 min · 0\.5 USD · 20% of tokens in<\/li>/);
  assert.match(html, /<span>critic setups<\/span><b>3<\/b>/);
  assert.match(html, /general critic, general, sonnet, delta review: 0 of 1 passed · 0 escapes<\/li>/);
  assert.match(html, /specialist security, security, opus: 0 of 1 passed<\/li>/);
  // Nothing recorded: no card, no guess.
  const bare = state(); bare.units[0].rounds = [];
  assert.doesNotMatch(hud(view(bare, decide(bare, T0), T0), T0), /critic setups|data-a="cost-/);
});

test('Unit page: Overlaps beside Depends on / Blocks, and Function calls wherever call data is read', async () => {
  const { staticCtx } = await import('../lib/hud.mjs');
  const s = state();
  s.units[0].touches = ['lib/a.mjs', 'lib/b.mjs']; s.units[1].detect = { paths: ['lib/b.mjs', 'lib/c.mjs'] };
  const v = view(s, decide(s, T0), T0);
  assert.deepEqual(v.units[0].overlaps, [{ id: 'ui', paths: ['lib/b.mjs'] }]);
  assert.match(unitPage(v, 'api', T0), /<h3 class="sub">Overlaps<\/h3><ul class="deps"><li data-a="ov-ui"><a [^>]*>ui<\/a> <span class="mono cause">lib\/b\.mjs<\/span><\/li><\/ul>/);
  const plain = state();
  assert.match(unitPage(view(plain, decide(plain, T0), T0), 'api', T0), /<h3 class="sub">Overlaps<\/h3><p class="empty">No other unit changes its files\.<\/p>/);
  // Call data read but none for this unit yet: the panel says how to compute it.
  const none = { get: () => null, list: () => [] };
  assert.match(unitPage(v, 'api', T0, { ...staticCtx('', 1), calls: none }), /<h2>Function calls<\/h2><\/summary>[\s\S]*?run\.mjs calls r1 api/);
  assert.doesNotMatch(unitPage(v, 'api', T0), /Function calls/, 'a page that reads no call data (the hosted copy) leaves it out');
});
