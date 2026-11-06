import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, decideUnit, sameGap, stats } from '../lib/rules.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const run = (units, extra = {}) => ({
  createdAt: new Date(T0).toISOString(), frozen: true, integration: { rounds: [] },
  budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, units, ...extra,
});
const unit = (rounds = [], extra = {}) => ({ id: 'u1', status: 'open', rounds, strategyChanges: 0, strategyAt: -1, ...extra });
const fail = (gap, score) => ({ verdict: 'fail', gap, score });

test('same gap is matched on word overlap, not exact text', () => {
  assert.equal(sameGap('Totals ignore the simulated clock', 'the totals ignore simulated clock'), true);
  assert.equal(sameGap('Totals ignore the simulated clock', 'Arabic label overflows on phones'), false);
  assert.equal(sameGap('', 'anything'), false);
});

test('a new unit builds; a failed unit builds again with the gap', () => {
  assert.equal(decideUnit(unit(), run([]), T0).action, 'build');
  const d = decideUnit(unit([fail('missing test')]), run([]), T0);
  assert.deepEqual([d.action, d.gap], ['build', 'missing test']);
});

test('same gap twice asks for a new strategy, then builds once one is recorded', () => {
  const rounds = [fail('the total is off by one cycle'), fail('total is still off by one cycle')];
  assert.equal(decideUnit(unit(rounds), run([]), T0).action, 'change-strategy');
  assert.equal(decideUnit(unit(rounds, { strategyChanges: 1, strategyAt: 2 }), run([]), T0).action, 'build');
});

test('the same gap after a change of strategy stops the unit as stuck', () => {
  const rounds = [fail('off by one cycle'), fail('off by one cycle'), fail('still off by one cycle')];
  const d = decideUnit(unit(rounds, { strategyChanges: 1, strategyAt: 2 }), run([]), T0);
  assert.deepEqual([d.action, d.reason], ['stop', 'stuck: same gap after a change of strategy']);
});

test('a unit stacked on a stopped unit stops instead of waiting forever', () => {
  const a = { ...unit(), id: 'a', status: 'stopped' };
  const b = { ...unit(), id: 'b', after: 'a' };
  assert.deepEqual(decideUnit(b, run([a, b]), T0), { action: 'stop', reason: 'blocked: a stopped' });
  assert.equal(decide(run([a, b]), T0).decision, 'stopped');
});

test('the time budget stops a waiting unit too', () => {
  const a = { ...unit(), id: 'a', status: 'building', heartbeatAt: new Date(T0).toISOString() };
  const b = { ...unit(), id: 'b', after: 'a' };
  assert.equal(decideUnit(b, run([a, b]), T0 + 241 * 60_000).reason, 'budget: time');
});

test('a hung critic is stale like a hung builder', () => {
  const u = unit([], { status: 'judging', heartbeatAt: new Date(T0).toISOString() });
  assert.equal(decideUnit(u, run([u]), T0 + 5 * 60_000).action, 'judge');
  assert.deepEqual(decideUnit(u, run([u]), T0 + 46 * 60_000), { action: 'check-stale', phase: 'judging' });
});

test('no progress for two rounds stops the unit', () => {
  const rounds = [fail('a', 6), fail('b', 5), fail('c', 6)];
  assert.equal(decideUnit(unit(rounds), run([]), T0).reason, 'no progress');
  assert.equal(decideUnit(unit([fail('a', 4), fail('b', 5), fail('c', 6)]), run([]), T0).action, 'build');
});

test('budgets stop units: rounds and wall-clock time', () => {
  const four = [fail('a'), fail('b'), fail('c'), fail('d')];
  assert.equal(decideUnit(unit(four), run([]), T0).reason, 'budget: rounds');
  assert.equal(decideUnit(unit(), run([]), T0 + 241 * 60_000).reason, 'budget: time');
});

test('a stacked unit waits for the unit it builds on', () => {
  const a = { ...unit(), id: 'a' };
  const b = { ...unit(), id: 'b', after: 'a' };
  assert.equal(decideUnit(b, run([a, b]), T0).action, 'wait');
  assert.equal(decideUnit(b, run([{ ...a, status: 'pass' }, b]), T0).action, 'build');
});

test('a building unit with no heartbeat for too long is stale', () => {
  const u = unit([], { status: 'building', heartbeatAt: new Date(T0).toISOString() });
  assert.equal(decideUnit(u, run([u]), T0 + 10 * 60_000).action, 'wait');
  assert.equal(decideUnit(u, run([u]), T0 + 46 * 60_000).action, 'check-stale');
});

test('run decision: split, continue, integrate, done, stopped', () => {
  assert.equal(decide(run([unit()], { frozen: false }), T0).decision, 'split');
  assert.equal(decide(run([unit()]), T0).decision, 'continue');
  const passed = { ...unit(), status: 'pass' };
  assert.equal(decide(run([passed]), T0).decision, 'integrate');
  assert.equal(decide(run([passed], { integration: { rounds: [{ verdict: 'pass' }] } }), T0).decision, 'done');
  assert.equal(decide(run([{ ...unit(), status: 'stopped' }]), T0).decision, 'stopped');
});

test('stats suggest a round budget from past rounds-to-pass, capped at 8', () => {
  const runOf = (ns) => ({ units: ns.map((n) => ({ status: 'pass', rounds: Array(n).fill({}) })) });
  const s = stats([{ units: [...runOf([1, 2, 2, 3, 9]).units, { status: 'stopped', rounds: [] }] }]);
  assert.deepEqual([s.medianRoundsToPass, s.p80RoundsToPass, s.suggestedMaxRounds], [2, 3, 4]);
  assert.equal(s.stoppedShare, 0.17);
  assert.equal(stats([runOf([1, 9, 9, 9, 9])]).suggestedMaxRounds, 8, 'never above 8');
  assert.equal(stats([]).suggestedMaxRounds, null);
});

test('gaps in non-Latin scripts are compared too', () => {
  assert.equal(sameGap('زر الدخول لا يعمل على الجوال', 'زر الدخول لا يعمل على الجوال'), true);
  assert.equal(sameGap('登录按钮 在手机上 无法使用', '登录按钮 在手机上 无法使用'), true);
  assert.equal(sameGap('زر الدخول لا يعمل', 'الرسوم تحسب مرتين'), false);
});

test('same gap compares causes when both rounds have one, wording otherwise', () => {
  const r = (gap, cause) => ({ verdict: 'fail', gap, cause });
  assert.equal(sameGap(r('ICU plural keys misread', 'hand-rolled ICU parser'), r('rich-text tags ignored', 'Hand rolled ICU parser')), true, 'different symptoms, one cause');
  assert.equal(sameGap(r('total off by one cycle', 'cycle boundary'), r('total off by one cycle', 'timezone')), false, 'same words, different causes');
  assert.equal(sameGap(r('total off by one cycle', 'cycle boundary'), r('the total is off by one cycle')), true, 'one cause missing: wording decides');
  assert.equal(sameGap('total off by one cycle', r('total is off by one cycle', null)), true, 'plain strings still work');
});

test('two rounds with one cause ask for a new strategy even when the gap text differs', () => {
  const rounds = [{ ...fail('placeholder-as-error breaks i18next plurals', 6), cause: 'hand-rolled ICU scan' }, { ...fail('rich-text tags pass unchecked', 7), cause: 'hand-rolled ICU scan' }];
  assert.equal(decideUnit(unit(rounds), run([]), T0).action, 'change-strategy');
});
