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
  assert.match(out, /^r1 \[code\] · continue/);
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
