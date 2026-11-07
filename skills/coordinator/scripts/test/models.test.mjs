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
import { atLeast, family, normalize, route, whoUnit } from '../lib/models.mjs';

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
  // Ranked against the fixed strong model, not the strongest name in the table.
  const low = normalize({ critic: 'sonnet', builder: 'haiku', mechanical: 'haiku' });
  assert.equal(route(low, 'critic').model, 'opus');
  for (const role of ['specialist', 'visual-critic', 'integrator']) assert.equal(route(normalize({ [role]: 'haiku' }), role).model, 'opus');
  // An unranked critic name is not the strong one: ignored.
  assert.equal(route(normalize({ critic: 'gpt-4o-mini' }), 'critic').model, 'opus');
  // A Codex table: strong declared, unranked names used as given.
  const codex = normalize({ strong: 'gpt-x', critic: 'gpt-x', mechanical: 'gpt-x-mini' });
  assert.equal(route(codex, 'builder', 'copy').model, 'gpt-x-mini');
  assert.equal(route(codex, 'critic').model, 'gpt-x');
  assert.equal(route(normalize({ strong: 'gpt-x', critic: 'gpt-x-mini' }), 'critic').model, 'gpt-x');
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
  ok('start', 'm', 'docs', '--model', 'sonnet', '--why', 'docs-only', '--force-model', 'typo only'); ok('built', 'm', 'docs');
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

test('names compare case-insensitively and full ids map to their family', () => {
  assert.equal(family('Claude-Haiku-4-5'), 'haiku');
  assert.equal(family('claude-sonnet-4-5-20250929'), 'sonnet');
  assert.equal(family('claude-3-5-haiku-20241022'), 'haiku');
  assert.equal(family('claude-opus-4-1'), 'opus');
  assert.equal(family('gpt-4o-mini'), null);
  assert.equal(atLeast('OPUS', 'opus'), true);
  assert.equal(atLeast('claude-opus-4-1', 'opus'), true);
  assert.equal(atLeast('claude-sonnet-4-5', 'opus'), false);
  assert.equal(route(normalize({ critic: 'claude-haiku-4-5' }), 'critic').model, 'opus');
  assert.equal(route(normalize({ critic: 'Claude-Opus-4-1' }), 'critic').model, 'Claude-Opus-4-1');
});

test('verdict refuses an unranked or cheaper judge unless it is the declared strong', () => {
  const dir = folder(); const ok = okIn(dir);
  ok('init', 'v', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'v', 'a', '--bar', 'b'); ok('add', 'v', 'b', '--bar', 'b'); ok('freeze', 'v');
  ok('start', 'v', 'a'); ok('built', 'v', 'a');
  for (const m of ['gpt-4o-mini', 'claude-sonnet-4-5', 'HAIKU']) assert.equal(cli(dir, 'verdict', 'v', 'a', 'pass', '--evidence', 'e', '--model', m).code, 1, m);
  ok('verdict', 'v', 'a', 'pass', '--evidence', 'e', '--model', 'claude-opus-4-1');
  writeFileSync(cfgFile(dir), JSON.stringify({ models: { strong: 'gpt-x' } }));
  ok('start', 'v', 'b'); ok('built', 'v', 'b');
  assert.equal(cli(dir, 'verdict', 'v', 'b', 'pass', '--evidence', 'e', '--model', 'gpt-x-mini').code, 1);
  ok('verdict', 'v', 'b', 'pass', '--evidence', 'e', '--model', 'gpt-x');
  // integrate records the integrator's model, under the same floor.
  assert.equal(cli(dir, 'integrate', 'v', 'pass', '--evidence', 'e', '--model', 'gpt-x-mini').code, 1);
  ok('integrate', 'v', 'pass', '--evidence', 'e', '--model', 'gpt-x');
  assert.equal(JSON.parse(readFileSync(join(dir, 'runs', 'v', 'state.json'), 'utf8')).integration.rounds[0].judgedBy, 'gpt-x');
});

test('security, money, migrations and auth builders are pinned to strong; several classes take the strongest', () => {
  const cfg = normalize({ auth: 'haiku', migrations: 'sonnet', mechanical: 'haiku' });
  for (const c of ['security', 'money', 'migrations', 'auth']) assert.equal(route(cfg, 'builder', c).model, 'opus', c);
  assert.equal(route(cfg, 'builder', 'renames,auth').model, 'opus');
  assert.equal(route(cfg, 'builder', ['mirror', 'money']).model, 'opus');
  assert.equal(route(cfg, 'builder', ['docs', 'api']).model, null); // a non-mechanical class keeps the default
  assert.equal(route(cfg, 'builder', ['docs', 'copy']).model, 'haiku');
});

test('table lookups ignore inherited names', () => {
  const cfg = normalize(undefined);
  for (const c of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) assert.deepEqual(route(cfg, 'builder', c), { model: null, why: 'default' }, c);
});

test('after a try failed on a cheaper model, start refuses a cheaper one unless forced, and next suggests strong', () => {
  const dir = folder(); const ok = okIn(dir);
  ok('init', 'e', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'e', 'a', '--bar', 'b'); ok('freeze', 'e');
  ok('start', 'e', 'a', '--model', 'sonnet', '--why', 'docs'); ok('built', 'e', 'a');
  ok('verdict', 'e', 'a', 'fail', '--evidence', 'e', '--gap', 'g', '--score', '4', '--model', 'opus');
  const n = ok('next', 'e').units.find((u) => u.id === 'a');
  assert.equal(n.model, 'opus'); assert.match(n.modelWhy, /sonnet failed/);
  const r = cli(dir, 'start', 'e', 'a', '--model', 'claude-haiku-4-5');
  assert.equal(r.code, 1); assert.match(r.err, /force-model/);
  assert.equal(cli(dir, 'start', 'e', 'a', '--model', 'sonnet', '--force-model').code, 1); // a reason is required
  ok('start', 'e', 'a', '--model', 'sonnet', '--force-model', 'one-word typo, opus is down');
  assert.match(JSON.parse(readFileSync(join(dir, 'runs', 'e', 'state.json'), 'utf8')).notes.at(-1).text, /again after sonnet failed: one-word typo/);
});

test('setRouting refuses a malformed coordinator.json; init <run> --models writes only when the run is made', () => {
  const dir = folder(); const ok = okIn(dir);
  writeFileSync(cfgFile(dir), '{ not json');
  const r = cli(dir, 'init', '--models', 'off');
  assert.equal(r.code, 1); assert.match(r.err, /not valid JSON/);
  assert.equal(readFileSync(cfgFile(dir), 'utf8'), '{ not json');
  writeFileSync(cfgFile(dir), '{}');
  ok('init', 'x', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  assert.equal(cli(dir, 'init', 'x', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--models', 'off').code, 1); // run exists
  assert.equal(readFileSync(cfgFile(dir), 'utf8'), '{}');
  ok('init', 'y', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--models', 'off');
  assert.equal(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).models, false);
});

test('the dashboard shows rounds and pass rate per builder model while the run is open', () => {
  const dir = folder(); const ok = okIn(dir);
  ok('init', 'h', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'h', 'a', '--bar', 'b'); ok('freeze', 'h');
  ok('start', 'h', 'a', '--model', 'sonnet'); ok('built', 'h', 'a');
  ok('verdict', 'h', 'a', 'fail', '--evidence', 'e', '--gap', 'g', '--score', '4', '--model', 'opus');
  const html = readFileSync(join(dir, 'runs', 'h', 'hud.html'), 'utf8');
  assert.match(html, /data-a="budget-models"[\s\S]*sonnet 0\/1 passed \(0\)/);
  assert.match(cli(dir, 'show', 'h').out, /models {3}sonnet 0\/1 passed \(0\)/);
});
