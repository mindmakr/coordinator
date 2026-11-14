// Critic setups and specialist critics: escapes are grouped by the setup of the
// verdict that passed a unit, and a unit with a required specialist cannot pass
// until that specialist has passed the same build; a general pass on a build a
// specialist failed closes the round as failed by that specialist (#126).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, openFindings, specialistFailure, stats } from '../lib/rules.mjs';
import { unitPage } from '../lib/unitpage.mjs';
import { text as textView, view } from '../lib/view.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-critics-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const state = (run) => JSON.parse(readFileSync(join(dir, 'runs', run, 'state.json'), 'utf8'));

test('stats and show give an escape rate per critic setup', () => {
  ok('init', 'cs', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--tag', 'crit');
  for (const u of ['a', 'b', 'c']) ok('add', 'cs', u, '--bar', 'b');
  ok('freeze', 'cs');
  const pass = (u, critic) => { ok('start', 'cs', u); ok('built', 'cs', u); ok('verdict', 'cs', u, 'pass', '--score', '9', '--evidence', 'tests green', ...(critic ? ['--critic', critic] : [])); };
  pass('a', 'sonnet critic'); pass('b', 'sonnet critic'); pass('c', 'review skill high + security');
  assert.equal(state('cs').units[0].rounds[0].critic, 'sonnet critic');
  ok('integrate', 'cs', 'pass', '--evidence', 'all green');
  ok('close', 'cs', '--outcome', 'done');
  ok('note', 'cs', '--kind', 'escape', '--unit', 'a', '--text', 'found on test');
  const st = ok('stats', '--tag', 'crit');
  assert.deepEqual(st.escapesBySetup, [
    { setup: 'review skill high + security', passed: 1, escapes: 0, rate: 0 },
    { setup: 'sonnet critic', passed: 2, escapes: 1, rate: 0.5 },
  ]);
  assert.match(cli('show', 'cs').out, /critics {2}review skill high \+ security: 0 escapes in 1 passed \(rate 0\) · sonnet critic: 1 escape in 2 passed \(rate 0\.5\)/);
});

test('a required specialist must pass the same build before the unit can pass', () => {
  ok('init', 'sp', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  ok('add', 'sp', 'auth', '--bar', 'b', '--specialist', 'security,visual');
  ok('freeze', 'sp'); ok('start', 'sp', 'auth'); ok('built', 'sp', 'auth');
  assert.match(cli('verdict', 'sp', 'auth', 'pass', '--score', '9', '--evidence', 'e').err, /specialist security, visual has not passed/);
  assert.match(cli('verdict', 'sp', 'auth', 'pass', '--evidence', 'e', '--specialist', 'money').err, /no specialist money/);
  ok('verdict', 'sp', 'auth', 'pass', '--evidence', 'screens ok', '--specialist', 'visual', '--critic', 'visual critic');
  ok('verdict', 'sp', 'auth', 'fail', '--severity', 'high', '--score', '4', '--gap', 'timing oracle', '--evidence', 'auth.ts:12', '--specialist', 'security');
  assert.equal(state('sp').units[0].status, 'judging', 'a specialist verdict does not end the round');
  ok('verdict', 'sp', 'auth', 'fail', '--severity', 'high', '--score', '5', '--gap', 'timing oracle (security specialist)', '--evidence', 'auth.ts:12');
  const r1 = state('sp').units[0].rounds[0];
  assert.equal(r1.specialists.security.verdict, 'fail'); assert.equal(r1.specialists.visual.critic, 'visual critic');

  // A new build is judged again by every specialist.
  ok('start', 'sp', 'auth'); ok('built', 'sp', 'auth');
  ok('verdict', 'sp', 'auth', 'pass', '--evidence', 'fixed', '--specialist', 'security');
  assert.match(cli('verdict', 'sp', 'auth', 'pass', '--score', '9', '--evidence', 'e').err, /specialist visual has not passed/);
  ok('verdict', 'sp', 'auth', 'pass', '--evidence', 'screens ok', '--specialist', 'visual');
  ok('verdict', 'sp', 'auth', 'pass', '--score', '9', '--evidence', 'all green', '--critic', 'review skill high');
  assert.equal(state('sp').units[0].status, 'pass');
});

// #126: a general pass on a build a required specialist failed is recorded as given, and the round
// closes as failed by that specialist, never as a general FAIL the general critic did not give.
test('a general pass on a build a specialist failed closes the round as failed by that specialist (#126)', () => {
  ok('init', 'sf', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--tag', 'sfail');
  ok('add', 'sf', 'pay', '--bar', 'b', '--specialist', 'money,screen');
  ok('freeze', 'sf'); ok('start', 'sf', 'pay'); ok('built', 'sf', 'pay');
  ok('verdict', 'sf', 'pay', 'pass', '--score', '9', '--evidence', 'screens ok', '--specialist', 'screen');
  // Every required specialist must still mark the build first.
  assert.match(cli('verdict', 'sf', 'pay', 'pass', '--score', '9', '--evidence', 'review clean').err, /specialist money has not passed this build/);
  ok('verdict', 'sf', 'pay', 'fail', '--severity', 'high', '--score', '4', '--gap', 'refund rounds half a cent away', '--cause', 'refund rounding', '--evidence', 'pay.ts:40', '--specialist', 'money');
  // B1: accepted; the round closes as failed by money, keeping the general outcome and score.
  ok('verdict', 'sf', 'pay', 'pass', '--score', '9', '--evidence', 'review clean', '--fold', 'nit: rename a local');
  const u = state('sf').units[0]; const r1 = u.rounds[0];
  assert.equal(u.status, 'open');
  assert.equal(r1.verdict, 'fail'); assert.equal(r1.general, 'pass'); assert.equal(r1.score, 9);
  assert.deepEqual(r1.failedBy, ['money']);
  assert.equal(r1.gap, 'refund rounds half a cent away'); assert.equal(r1.cause, 'refund rounding'); assert.equal(r1.severity, 'high');
  assert.equal(r1.evidence, 'review clean'); assert.equal(r1.folds, undefined, 'a failed round carries no fold-ins');
  assert.deepEqual(r1.findings, [{ severity: 'nit', text: 'rename a local' }], 'the general critic fold-in is kept as a finding');
  assert.equal(r1.specialists.money.verdict, 'fail'); assert.equal(r1.specialists.screen.verdict, 'pass');
  // B2: show, the unit page and stats say money failed it, and the general score is 9.
  const s1 = state('sf'); const v = view(s1, decide(s1), Date.now());
  const shown = cli('show', 'sf').out;
  assert.match(shown, /pay\s+open\s+1\/\d+\s+9 /);
  assert.match(shown, /└ failed by specialist money \(general critic: pass, 9\): refund rounds half a cent away \[cause: refund rounding\]/);
  assert.match(textView(v), /failed by specialist money/);
  const page = unitPage(v, 'pay');
  assert.match(page, /Round 1 <span class="chip[^"]*"[^>]*>fail<\/span> <span class="cause">failed by specialist money<\/span> <span class="cause">general critic: pass, score 9<\/span>/);
  assert.doesNotMatch(page, /<span class="cause">score 9<\/span>/);
  // B3: next treats it as any failed round: a fix round with the specialist's gap.
  const n1 = ok('next', 'sf').units.find((x) => x.id === 'pay');
  assert.equal(n1.action, 'build'); assert.equal(n1.gap, 'refund rounds half a cent away');
  // The same gap again: the same-gap rule applies as today.
  ok('start', 'sf', 'pay'); ok('built', 'sf', 'pay');
  ok('verdict', 'sf', 'pay', 'pass', '--evidence', 'screens ok', '--specialist', 'screen');
  ok('verdict', 'sf', 'pay', 'fail', '--severity', 'high', '--score', '5', '--gap', 'refund still rounds away', '--cause', 'refund rounding', '--evidence', 'pay.ts:41', '--specialist', 'money');
  ok('verdict', 'sf', 'pay', 'pass', '--score', '9', '--evidence', 'review clean');
  assert.equal(ok('next', 'sf').units.find((x) => x.id === 'pay').action, 'change-strategy');
  ok('strategy', 'sf', 'pay', '--text', 'round with integer cents');
  // A general pass with every required specialist passed still passes the unit as today.
  ok('start', 'sf', 'pay'); ok('built', 'sf', 'pay');
  ok('verdict', 'sf', 'pay', 'pass', '--evidence', 'cents exact', '--specialist', 'money');
  ok('verdict', 'sf', 'pay', 'pass', '--evidence', 'screens ok', '--specialist', 'screen');
  ok('verdict', 'sf', 'pay', 'pass', '--score', '9', '--evidence', 'all green');
  const r3 = state('sf').units[0].rounds[2];
  assert.equal(state('sf').units[0].status, 'pass'); assert.equal(r3.verdict, 'pass');
  assert.equal(r3.general, undefined); assert.equal(r3.failedBy, undefined);
  ok('integrate', 'sf', 'pass', '--evidence', 'all green'); ok('close', 'sf', '--outcome', 'done');
  const st = ok('stats', '--tag', 'sfail');
  assert.deepEqual(st.failedRoundsBy, { 'specialist money': 2 });
  assert.deepEqual(st.specialistFails, [
    { run: 'sf', unit: 'pay', round: 1, failedBy: ['money'], general: 'pass', score: 9 },
    { run: 'sf', unit: 'pay', round: 2, failedBy: ['money'], general: 'pass', score: 9 },
  ]);
});

test('specialistFailure: the failing marks, their gap, cause and worst severity', () => {
  assert.equal(specialistFailure({ a: { verdict: 'pass' } }), null);
  assert.equal(specialistFailure(undefined), null);
  assert.deepEqual(specialistFailure({ a: { verdict: 'pass' }, money: { verdict: 'fail', gap: 'g', cause: 'c', severity: 'medium' } }), { failedBy: ['money'], gap: 'g', cause: 'c', severity: 'medium' });
  assert.deepEqual(specialistFailure({ money: { verdict: 'fail', gap: 'g1', cause: 'c1', severity: 'medium' }, security: { verdict: 'fail', gap: 'g2', severity: 'high' } }),
    { failedBy: ['money', 'security'], gap: 'money: g1; security: g2', cause: null, severity: 'high' });
  assert.deepEqual(stats([]).failedRoundsBy, {});
  // The open findings of a round a specialist failed are the specialist's, not a general gap.
  assert.deepEqual(openFindings({ verdict: 'fail', general: 'pass', failedBy: ['money'], gap: 'g', severity: 'medium', specialists: { money: { verdict: 'fail', gap: 'g', severity: 'medium' } } }), [{ by: 'money', severity: 'medium', text: 'g' }]);
});
