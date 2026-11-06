// Critic setups and specialist critics: escapes are grouped by the setup of the
// verdict that passed a unit, and a unit with a required specialist cannot pass
// until that specialist has passed the same build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  ok('verdict', 'sp', 'auth', 'fail', '--score', '4', '--gap', 'timing oracle', '--evidence', 'auth.ts:12', '--specialist', 'security');
  assert.equal(state('sp').units[0].status, 'judging', 'a specialist verdict does not end the round');
  assert.match(cli('verdict', 'sp', 'auth', 'pass', '--score', '9', '--evidence', 'e').err, /specialist security has not passed/);
  ok('verdict', 'sp', 'auth', 'fail', '--score', '5', '--gap', 'timing oracle (security specialist)', '--evidence', 'auth.ts:12');
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
