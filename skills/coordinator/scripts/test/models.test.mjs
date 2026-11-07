// Model routing and recording (references/routing.md): which model built and
// judged each round, stats per model, the off switch, old state, and critics
// never routed below the strongest model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalize, route, whoUnit } from '../lib/models.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function folder() { const d = mkdtempSync(join(tmpdir(), 'coordinator-models-')); dirs.push(d); return d; }
function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const okIn = (dir) => (...a) => { const r = cli(dir, ...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const cfgFile = (dir) => join(dir, 'coordinator.json');

test('routing is on by default: mechanical builder work is cheap, critics strong, the rest default', () => {
  const cfg = normalize(undefined);
  assert.equal(cfg.on, true);
  assert.deepEqual(route(cfg, 'builder', 'docs'), { model: 'sonnet', why: 'docs (mechanical)' });
  assert.deepEqual(route(cfg, 'builder', 'auth-refactor'), { model: null, why: 'default' });
  assert.equal(route(cfg, 'critic').model, 'opus');
  assert.equal(route(cfg, 'integrator').model, 'opus');
});

test('critics are never routed below the strongest model, whatever the table says', () => {
  const cfg = normalize({ critic: 'haiku', specialist: 'sonnet', builder: 'opus', mechanical: 'sonnet' });
  assert.equal(route(cfg, 'critic').model, 'opus');
  assert.equal(route(cfg, 'specialist').model, 'opus');
  assert.equal(cfg.warnings.length, 2);
  assert.equal(route(cfg, 'builder', 'translations').model, 'sonnet');
  assert.equal(route(cfg, 'builder').model, 'opus');
  // A Codex table: unranked names are used as given.
  assert.equal(route(normalize({ critic: 'gpt-x', mechanical: 'gpt-x-mini' }), 'builder', 'copy').model, 'gpt-x-mini');
  assert.throws(() => normalize({ critic: 3 }), /model name/);
  assert.throws(() => normalize('yes'), /must be false or an object/);
});

test('init --models off|on writes "models" in coordinator.json and keeps other keys', () => {
  const dir = folder(); const ok = okIn(dir);
  writeFileSync(cfgFile(dir), JSON.stringify({ service: 'https://example.test' }));
  ok('init', '--models', 'off');
  assert.deepEqual(JSON.parse(readFileSync(cfgFile(dir), 'utf8')), { service: 'https://example.test', models: false });
  assert.deepEqual(ok('models', '--role', 'builder', '--class', 'docs'), { role: 'builder', class: 'docs', model: null, why: 'routing off' });
  ok('init', '--models', 'on');
  assert.deepEqual(JSON.parse(readFileSync(cfgFile(dir), 'utf8')), { service: 'https://example.test' });
  assert.equal(ok('models', '--role', 'builder', '--class', 'docs').model, 'sonnet');
  assert.equal(cli(dir, 'init', '--models', 'maybe').code, 1);
});

test('start and verdict record the models; the HUD, unit page and stats show them', () => {
  const dir = folder(); const ok = okIn(dir);
  ok('init', 'm', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--tag', 'mod');
  ok('add', 'm', 'docs', '--bar', 'b'); ok('add', 'm', 'core', '--bar', 'b'); ok('freeze', 'm');
  ok('start', 'm', 'docs', '--model', 'sonnet', '--why', 'docs-only');
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', 'm', 'state.json'), 'utf8')).units[0].builtBy, 'sonnet');
  ok('built', 'm', 'docs');
  const low = cli(dir, 'verdict', 'm', 'docs', 'pass', '--evidence', 'e', '--model', 'sonnet');
  assert.equal(low.code, 1); assert.match(low.err, /never routed down/);
  ok('verdict', 'm', 'docs', 'fail', '--evidence', 'e', '--gap', 'typo', '--score', '5', '--model', 'opus');
  ok('start', 'm', 'docs', '--model', 'sonnet', '--why', 'docs-only'); ok('built', 'm', 'docs');
  ok('verdict', 'm', 'docs', 'pass', '--evidence', 'e', '--model', 'opus');
  ok('start', 'm', 'core'); ok('built', 'm', 'core'); ok('verdict', 'm', 'core', 'pass', '--evidence', 'e', '--model', 'opus');
  const u = JSON.parse(readFileSync(join(dir, 'runs', 'm', 'state.json'), 'utf8')).units[0];
  assert.deepEqual([u.rounds[0].builtBy, u.rounds[0].builtWhy, u.rounds[0].judgedBy], ['sonnet', 'docs-only', 'opus']);
  assert.equal(u.builtBy, undefined);
  assert.match(readFileSync(join(dir, 'runs', 'm', 'hud.html'), 'utf8'), /built by sonnet \(docs-only\) · judged by opus/);
  assert.match(readFileSync(join(dir, 'runs', 'm', 'units', 'docs.html'), 'utf8'), /data-a="r1-who">built by sonnet \(docs-only\) · judged by opus/);
  assert.equal(cli(dir, 'start', 'm', 'core', '--why', 'docs').code, 1);
  ok('integrate', 'm', 'pass', '--evidence', 'e'); ok('close', 'm', '--outcome', 'done');
  const st = ok('stats', '--tag', 'mod');
  assert.deepEqual(st.roundsByBuilderModel, [
    { model: '(not recorded)', rounds: 1, passed: 1, passRate: 1 },
    { model: 'sonnet', rounds: 2, passed: 1, passRate: 0.5 },
  ]);
  assert.deepEqual(st.roundsByJudgeModel, [{ model: 'opus', rounds: 3 }]);
});

test('routing off: any judging model is recorded, nothing refused', () => {
  const dir = folder(); const ok = okIn(dir);
  writeFileSync(cfgFile(dir), JSON.stringify({ models: false }));
  ok('init', 'o', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'o', 'a', '--bar', 'b'); ok('freeze', 'o');
  ok('start', 'o', 'a', '--model', 'haiku'); ok('built', 'o', 'a');
  ok('verdict', 'o', 'a', 'pass', '--evidence', 'e', '--model', 'sonnet');
});

test('old state without model fields loads and shows no model line', () => {
  const dir = folder(); const ok = okIn(dir);
  ok('init', 'old', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'old', 'a', '--bar', 'b'); ok('freeze', 'old');
  ok('start', 'old', 'a'); ok('built', 'old', 'a'); ok('verdict', 'old', 'a', 'pass', '--evidence', 'e');
  ok('hud', 'old');
  assert.doesNotMatch(readFileSync(join(dir, 'runs', 'old', 'hud.html'), 'utf8'), /data-a="who-/);
  assert.equal(whoUnit({ status: 'pass', rounds: [{ verdict: 'pass' }] }), null);
});
