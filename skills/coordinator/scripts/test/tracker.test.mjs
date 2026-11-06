import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask } from '../lib/questions.mjs';
import { isTracker, marker, md, trackerBody, unitState } from '../lib/tracker.mjs';

const run = () => ({
  id: 'r1', budget: { maxRounds: 4 }, closed: null, notes: [],
  units: [{ id: 'u1', title: 'Totals <b>', status: 'building', rounds: [{ n: 1, verdict: 'fail', score: 4, gap: 'off by @alice [x](javascript:alert(1)) <img>', cause: 'stale cache' }] }],
});

test('the tracker body starts with its marker, says the state and tries, and escapes run text', () => {
  const b = trackerBody(run(), 'u1', { url: 'https://svc.example/r/a/b/run/r1/unit/u1', detail: true, github: ['PR acme/web#12 merged'] });
  assert.ok(isTracker(b, 'r1', 'u1'));
  assert.equal(b.startsWith(marker('r1', 'u1')), true);
  assert.match(b, /\*\*State:\*\* building/);
  assert.match(b, /1 of 4 · scores 4 · last verdict fail/);
  assert.match(b, /Totals &lt;b&gt;/);
  assert.equal(/@alice/.test(b), false, 'no mention pings');
  assert.equal(b.includes('[x](javascript'), false, 'no link from run text');
  assert.match(b, /stale cache/);
  assert.match(b, /PR acme/);
  assert.match(b, /\[Open the unit on the dashboard\]\(https:\/\/svc\.example/);
});

test('without detail the gap, cause and question text stay out', () => {
  const s = run();
  ask(s, { question: 'secret plan?', header: 'Plan', option: ['a|x', 'b|y'], unit: 'u1' });
  const b = trackerBody(s, 'u1');
  assert.equal(b.includes('stale cache'), false);
  assert.equal(b.includes('Plan'), false);
  assert.match(b, /1 open question/);
  assert.equal(unitState(s, s.units[0]), 'needs you');
  assert.equal(trackerBody(s, 'nope'), null);
});

test('unit states for the board', () => {
  const s = run();
  for (const [status, want] of [['pass', 'passed'], ['stopped', 'stopped'], ['judging', 'judging'], ['open', 'building'], ['building', 'building']]) {
    s.units[0].status = status; assert.equal(unitState(s, s.units[0]), want);
  }
  assert.equal(md('a\n\nb `c` #1'), 'a b \\`c\\` \\#1');
});
