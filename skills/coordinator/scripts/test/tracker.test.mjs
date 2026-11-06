import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask } from '../lib/questions.mjs';
import { isTracker, marker, md, trackerBody, unitState } from '../lib/tracker.mjs';

const run = () => ({
  id: 'r1', budget: { maxRounds: 4 }, closed: null, notes: [],
  units: [{ id: 'u1', title: 'Totals <b> https://evil.example/x @alice', status: 'building', rounds: [{ n: 1, verdict: 'fail', score: 4, gap: 'off by @alice [x](javascript:alert(1)) <img> ` www.evil.example', cause: 'stale cache' }] }],
});

// Every piece of run text in the body sits inside a code span, so GitHub renders none of it.
const outsideCode = (body) => body.split('\n').map((l) => l.replace(/(`+)(?:(?!\1).)*?\1/g, '')).join('\n');

test('the tracker body starts with its marker, says the state and tries, and puts run text in code spans', () => {
  const b = trackerBody(run(), 'u1', { url: 'https://svc.example/r/a/b/run/r1/unit/u1', detail: true, github: ['PR acme/web#12 merged'] });
  assert.ok(isTracker(b, 'r1', 'u1'));
  assert.equal(b.startsWith(marker('r1', 'u1')), true);
  assert.match(b, /\*\*State:\*\* building/);
  assert.match(b, /1 of 4 · scores 4 · last verdict `fail`/);
  assert.match(b, /`Totals <b> https:\/\/evil\.example\/x @alice`/);
  assert.match(b, /`stale cache`/);
  assert.match(b, /`PR acme\/web#12 merged`/);
  const bare = outsideCode(b);
  for (const bad of ['@alice', 'evil.example', '<b>', '<img>', 'javascript:', 'acme/web#12']) assert.equal(bare.includes(bad), false, `${bad} outside a code span`);
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

test('unit states for the board; code spans survive backticks in the text', () => {
  const s = run();
  for (const [status, want] of [['pass', 'passed'], ['stopped', 'stopped'], ['judging', 'judging'], ['open', 'building'], ['building', 'building']]) {
    s.units[0].status = status; assert.equal(unitState(s, s.units[0]), want);
  }
  assert.equal(md('a\n\nb `c` #1'), '``a b `c` #1``');
  assert.equal(md('`x`'), '`` `x` ``');
  assert.equal(md(''), '');
});

test('hostile numbers and ids from a raw run.init never reach the comment raw', () => {
  const s = run();
  const evil = '<img src=x onerror=alert(1)> @alice https://evil.example';
  s.budget.maxRounds = evil;
  s.units[0].rounds[0].score = evil;
  s.id = 'r1 --> <b>x</b>';
  const b = trackerBody(s, 'u1');
  assert.match(b, /1 of \? · scores –/);
  assert.ok(b.startsWith('<!-- coordinator:tracker run=r1--bxb unit=u1 -->'), 'no > survives, so the comment cannot close early');
  const bare = outsideCode(b);
  for (const bad of ['<img', '@alice', 'evil.example', '<b>']) assert.equal(bare.includes(bad), false, bad);
  for (const n of [-1, 1.5, '4', null, Infinity]) { s.budget.maxRounds = n; assert.match(trackerBody(s, 'u1'), /of \?/, String(n)); }
  s.units[0].rounds = 'not a list';
  assert.match(trackerBody(s, 'u1'), /Tries:\*\* 0 of \?/);
});
