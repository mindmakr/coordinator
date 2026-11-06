import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hud } from '../lib/hud.mjs';
import { decide } from '../lib/rules.mjs';
import { text, view } from '../lib/view.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const fail = (n, min, gap, cause) => ({ n, verdict: 'fail', score: 4, gap, cause, evidence: 'vitest: 2 failed', at: at(min) });
const unit = (id, extra = {}) => ({ id, bar: `${id} works; and more`, after: null, status: 'open', strategyChanges: 0, strategyAt: -1, heartbeatAt: null, rounds: [], ...extra });
const state = (extra = {}) => ({
  id: 'r1', tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [],
  budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
  createdAt: at(0), frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null,
  units: [
    unit('u1', { status: 'pass', title: '#1 Security gaps', link: 'https://github.com/o/r/issues/1', rounds: [{ n: 1, verdict: 'pass', score: 9, gap: null, evidence: 'all green', at: at(30) }] }),
    unit('u2', { rounds: [fail(1, 20, 'totals off by one', 'cycle dates'), fail(2, 40, 'still off by one', 'cycle dates')], strategyChanges: 1, strategyAt: 2 }),
    unit('u3', { status: 'building', heartbeatAt: at(44) }),
    unit('u4', { after: 'u3' }),
  ],
  notes: [],
  ...extra,
});
const render = (s, min = 45) => { const v = view(s, decide(s, T0 + min * 60_000), T0 + min * 60_000); return { v, html: hud(v, T0 + min * 60_000), txt: text(v) }; };

test('the situation is the lead\'s latest note, or counted from the state', () => {
  let r = render(state());
  assert.equal(r.v.situation.text, '1 of 4 tasks in progress, 1 done, 2 waiting.');
  assert.match(r.txt, /^situation {2}1 of 4 tasks in progress, 1 done, 2 waiting\.$/m);
  assert.match(r.html, /counted from the state/);
  r = render(state({ notes: [{ kind: 'situation', text: 'old', at: at(5) }, { kind: 'situation', text: 'u2 keeps missing the cycle dates; u3 about 15 min.', at: at(41) }] }));
  assert.equal(r.v.situation.text, 'u2 keeps missing the cycle dates; u3 about 15 min.');
  assert.match(r.html, /<p>u2 keeps missing the cycle dates; u3 about 15 min\.<\/p>/);
  assert.match(r.html, /the lead, 2026-01-01 00:41 UTC/);
});

test('needs you lists open questions with the recommendation, and is calm when there are none', () => {
  let r = render(state());
  assert.match(r.html, /<div class="needs calm">Nothing needs you\.<\/div>/);
  assert.match(r.txt, /^needs you {2}nothing$/m);
  const notes = [
    { kind: 'question', text: 'Merge u1 now?', recommend: 'yes, the review says READY', at: at(31) },
    { kind: 'question', text: 'Use UTC?', at: at(32) },
    { kind: 'decision', text: 'UTC it is', answers: 'q2', at: at(33) },
  ];
  r = render(state({ notes }));
  assert.deepEqual(r.v.needsYou.map((q) => q.id), ['q1']);
  assert.match(r.html, /<div class="needs"><b>Needs you<\/b><ul><li><b>q1<\/b> Merge u1 now\?<br><span class="rec">Recommended: yes, the review says READY<\/span>/);
  assert.match(r.txt, /^needs you {2}q1: Merge u1 now\? → recommended: yes, the review says READY$/m);
  assert.match(r.txt, /open {4}1 questions/);
  assert.match(r.html, /q2 \(answered\): Use UTC\?/);
  assert.equal(render(state({ notes, closed: { outcome: 'partial', at: at(50) } })).v.needsYou.length, 0, 'a closed run needs nobody');
});

test('time left is rough: none before a try finishes, then median tries on the longest chain', () => {
  const none = render(state({ units: [unit('a', { status: 'building' })] }));
  assert.equal(none.v.timeLeft, 'No estimate yet: no try has finished. The time budget has 3 h 15 min left.');
  // tries took 30 (u1), 20 and 20 (u2): median 20. Chain u3 → u4 is 2 tries, plus integration: 3.
  const r = render(state());
  assert.equal(r.v.timeLeft, 'About 1 h (rough: 3 more tries at a median 20 min each); the time budget has 3 h 15 min left.');
  assert.match(r.html, /<b>Time left<\/b>About 1 h \(rough/);
  assert.match(render(state(), 300).v.timeLeft, /the time budget is spent/);
  assert.equal(render(state({ closed: { outcome: 'done', at: at(50) } })).v.timeLeft, 'None: the run is closed.');
});

test('each unit says what it is for, how it went and what happens next', () => {
  const { v, html } = render(state());
  const say = Object.fromEntries(v.units.map((u) => [u.id, u.sentence]));
  assert.equal(say.u1, '#1 Security gaps. Passed on try 1; nothing left to do.');
  assert.equal(say.u2, 'u2 works. Failed twice in a row: cycle dates; next another try.');
  assert.equal(say.u3, 'u3 works. Building, try 1; next a critic checks it when the builder finishes.');
  assert.equal(say.u4, 'u4 works. Waiting for u3; starts when it passes.');
  assert.ok(html.indexOf('<p class="say">u2 works.') < html.indexOf('round 2/4'), 'the sentence comes before the scores');
  assert.match(html, /<details class="raw"><summary>Gap and evidence<\/summary><dl><dt>Last gap<\/dt><dd>still off by one/);
  assert.match(html, /<a href="https:\/\/github.com\/o\/r\/issues\/1" rel="noreferrer">link<\/a>/);
  assert.match(html, /u1 · #1 Security gaps/);
});

test('attention: two failed tries in a row, or a silent agent, earn a badge', () => {
  const { v, html, txt } = render(state());
  assert.deepEqual(v.units.map((u) => u.attention), [null, 'failed twice in a row', null, null]);
  assert.equal((html.match(/class="chip flag"/g) ?? []).length, 1);
  assert.match(txt, /^ +! u2 works\. Failed twice in a row/m);
  assert.equal(render(state(), 100).v.units[2].attention, 'no word from its agent for a while');
});

test('lead and agent text is escaped everywhere, and a non-web link is not a link', () => {
  const s = state({
    notes: [{ kind: 'situation', text: '<img src=x onerror=alert(1)>', at: at(41) }, { kind: 'question', text: '<b>q</b>', recommend: '"><script>x</script>', at: at(42) }],
  });
  s.units[0].title = '<i>t</i>'; s.units[0].link = 'javascript:alert(1)';
  s.units[1].rounds[1].evidence = '<svg onload=1>';
  const { html } = render(s);
  assert.doesNotMatch(html, /<img|<script|<svg onload|<i>t|href="javascript/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Recommended: &quot;&gt;&lt;script&gt;/);
  assert.match(html, /<span class="cause">javascript:alert\(1\)<\/span>/);
});

test('an old state (no titles, links, situation, answers or notes) still loads', () => {
  const s = state({ notes: undefined });
  for (const u of s.units) { delete u.title; delete u.link; }
  const { v, html, txt } = render(s);
  assert.equal(v.units[0].sentence, 'u1 works. Passed on try 1; nothing left to do.');
  assert.equal(v.needsYou.length, 0);
  assert.match(html, /Nothing needs you/);
  assert.match(txt, /^situation /m);
});
