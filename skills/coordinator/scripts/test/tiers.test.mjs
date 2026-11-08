// Check tiers (#65): open-ended goals are noted at init, a repeated concurrency or
// consistency cause carries the "one shared writer" hint, and the briefs scope checks
// to what changed (mapped tests, one full suite per head, a delta review from round 2,
// older gaps under OUT-OF-FENCE).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openWords } from '../lib/openbar.mjs';
import { decideUnit } from '../lib/rules.mjs';
import { SHARED_WRITER, strategyHint } from '../lib/strategy.mjs';
import { buildBrief } from '../lib/briefs.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-tiers-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: dir, env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const state = (run) => JSON.parse(readFileSync(join(dir, 'runs', run, 'state.json'), 'utf8'));

test('openbar notes "no way to …" and "nothing … unseen", and leaves closed lines alone', () => {
  assert.deepEqual(openWords('No way for an operator to approve on something they did not see'), ['no way to …']);
  assert.deepEqual(openWords('there is no path to approve a request nobody opened'), ['no way to …']);
  assert.deepEqual(openWords('Nothing an operator approves goes unseen'), ['nothing … unseen']);
  assert.deepEqual(openWords('nothing slips past the review'), ['nothing … unseen']);
  for (const fine of [
    'Given an HR admin without the permission, when they open /hr/payroll, then they get a 403 and no data.',
    'It should show nothing when the list is empty',
    'No way to approve: the three routes listed in routes.md return 403 for a viewer',
    'the approve button is hidden; nothing else changes',
  ]) assert.deepEqual(openWords(fine), [], fine);
});

test('init checks the goal line as well as the bar', () => {
  const w = ok('init', 'g1', '--goal', 'No way for an operator to approve on something they did not see', '--bar', 'the tests in test/x pass', '--fence', 'f');
  assert.match(w.warning, /check this line, it may be open-ended: the goal \(no way to …\)/);
  assert.doesNotMatch(w.warning, /the bar/);
  const kept = ok('init', 'g2', '--goal', 'No way for an operator to approve on something they did not see', '--bar', 'b', '--fence', 'f', '--accept-open');
  assert.equal(kept.warning, undefined);
  assert.ok(state('g2').notes.some((n) => n.kind === 'bar' && /the goal: "No way for an operator/.test(n.text)));
  assert.equal(ok('init', 'g3', '--goal', 'approve shows the three fields listed in the issue', '--bar', 'b', '--fence', 'f').warning, undefined);
});

const T0 = Date.parse('2026-01-01T00:00:00Z');
const run = { createdAt: new Date(T0).toISOString(), frozen: true, integration: { rounds: [] }, budget: { maxRounds: 6, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, units: [] };
const unit = (rounds) => ({ id: 'u1', status: 'open', rounds, strategyChanges: 0, strategyAt: -1 });
const fail = (cause, gap) => ({ verdict: 'fail', score: 5, severity: 'high', cause, gap });

test('change-strategy carries the shared-writer hint for a repeated concurrency or consistency cause', () => {
  const d = decideUnit(unit([fail('gate checked outside lock', 'approve reads the gate before taking the lock'), fail('gate checked outside lock', 'reject has the same race')]), run, T0);
  assert.equal(d.action, 'change-strategy');
  assert.equal(d.hint, SHARED_WRITER);
  assert.match(d.hint, /one shared writer.*guard test/);
  // Another kind of cause gets the step without a hint.
  const other = decideUnit(unit([fail('hand-rolled ICU parser', 'plural forms wrong'), fail('hand-rolled ICU parser', 'plural forms still wrong')]), run, T0);
  assert.equal(other.action, 'change-strategy');
  assert.equal(other.hint, undefined);
  assert.deepEqual(strategyHint({ cause: 'totals out of sync between views' }), { hint: SHARED_WRITER });
  assert.deepEqual(strategyHint({ cause: 'label overflows on phones' }), {});
});

test('a failed round keeps the head it judged, and the next critic brief reviews the delta from it', () => {
  ok('init', 'd1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'd1', 'a', '--bar', 'b'); ok('freeze', 'd1');
  ok('start', 'd1', 'a'); ok('built', 'd1', 'a', '--head', 'abc1234');
  const first = buildBrief(state('d1'), { role: 'critic', unit: 'a' });
  assert.doesNotMatch(first, /git diff/, 'round 1 reviews the whole unit');
  ok('verdict', 'd1', 'a', 'fail', '--score', '5', '--gap', 'g', '--evidence', 'e', '--severity', 'high', '--head', 'def5678');
  assert.equal(state('d1').units[0].rounds[0].reviewedHead, 'def5678');
  const second = buildBrief(state('d1'), { role: 'critic', unit: 'a' });
  assert.match(second, /review the delta, `git diff def5678 <head>`/);
  assert.match(second, /passes by reference to the last round's evidence/);
  assert.match(second, /OUT-OF-FENCE: anything found outside scope, and gaps that predate this change/);
  assert.match(second, /only if nothing has failed the round, run the full suite once on the head/);
  const builder = buildBrief(state('d1'), { role: 'builder', unit: 'a' });
  assert.match(builder, /tests mapped to the files you changed.*vitest related --run/s);
  assert.doesNotMatch(builder, /full suite once before you report/);
});
