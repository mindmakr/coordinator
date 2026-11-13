// Running a CEB trial (references/ceb-bench.md), with a stand-in for docker and the harness: the run
// finishes, the record names the configured model in every role, the cap is passed on and stops new
// tasks, and no secret reaches the argument list or the trial folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASIS, confirmPlan, estimate, intake, planOf } from '../lib/ceb/bench.mjs';
import { openManifest } from '../lib/ceb/manifest.mjs';
import { priceList } from '../lib/ceb/prices.mjs';
import { runPlan, secretsFrom, trialDir, trialsOf } from '../lib/ceb/runner.mjs';
import { dockerArgs, harnessArgs, IN, promptFor, readClaudeReport, timeoutMinutes } from '../lib/ceb/trial.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const RUN = here('../run.mjs');
const FIXTURE = here('./fixtures/ceb/CEB-2026.12/manifest.json');
const SUITE = 'CEB-2026.12';
const MODEL = 'claude-opus-5-5';
const SECRET = 'sk-test-not-a-real-key-0123456789';
const opened = openManifest(readFileSync(FIXTURE), readFileSync(`${FIXTURE}.sig`, 'utf8'));
const now = new Date('2026-11-13T09:00:00Z');

function plan(over = {}, { confirmed = true } = {}) {
  const o = { model: MODEL, effort: 'high', cap: '20 USD', mode: 'practice', task: 'refund-crosses-month', ...over };
  const { config, tasks, price } = intake(o, { manifest: opened.manifest, list: priceList(SUITE), harness: over.harness ?? 'claude-code' });
  const record = planOf({ id: 'bench-test', now, opened, config, tasks, est: estimate(tasks, price, BASIS[SUITE]) });
  return confirmed ? confirmPlan(record, 'yes, run it', now) : record;
}
const setup = () => {
  const base = mkdtempSync(join(tmpdir(), 'ceb-run-'));
  const bin = join(base, 'claude-linux');
  writeFileSync(bin, 'not a real program');
  return { base, harnessBin: bin };
};
const usage = (model, costly = false) => ({ [model]: { inputTokens: 100_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 50_000, outputTokens: costly ? 200_000 : 20_000 } });
const DIFF = 'diff --git a/src/report.js b/src/report.js\n--- a/src/report.js\n+++ b/src/report.js\n@@ -1 +1 @@\n-old\n+new\n';
const hostOf = (args, at) => { const m = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(`:${at}`)); return m ? m.slice(0, -(at.length + 1)) : null; };

// Stands in for `docker`: answers the version check, and for a trial writes what the container would leave.
function docker({ models = usage(MODEL), builder = MODEL, critic = MODEL, exit = '0', leakInto = null, calls = [] } = {}) {
  return Object.assign((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    assert.equal(cmd, 'docker');
    if (args.at(-1) === '--version') return { status: 0, stdout: '2.1.323 (Claude Code)\n', stderr: '' };
    if (args[0] !== 'run') return { status: 0, stdout: '', stderr: '' };
    const out = hostOf(args, IN.out); const state = hostOf(args, IN.state); const home = hostOf(args, IN.home);
    writeFileSync(join(out, 'base'), 'abc123\n');
    writeFileSync(join(out, 'harness.out'), `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 31, duration_ms: 600_000, duration_api_ms: 420_000, total_cost_usd: 1.3, session_id: 's-1', modelUsage: models })}\n`);
    writeFileSync(join(out, 'harness.err'), '');
    writeFileSync(join(out, 'diff.patch'), DIFF);
    writeFileSync(join(out, 'exit'), `${exit}\n`);
    if (state) { mkdirSync(join(state, 'runs', 'r1'), { recursive: true }); writeFileSync(join(state, 'runs', 'r1', 'state.json'), JSON.stringify({ id: 'r1', units: [{ id: 'u1', builtBy: builder, rounds: [{ builtBy: builder, judgedBy: critic, verdict: 'pass' }] }] })); }
    if (leakInto) writeFileSync(join(home, leakInto), `token=${opts.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    return { status: 0, stdout: '', stderr: '' };
  }, { calls });
}
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));

test('a trial through the Coordinator loop finishes, and its record names the configured model in every role', () => {
  const { base, harnessBin } = setup();
  const exec = docker();
  const p = plan();
  const result = runPlan({ plan: p, base, harnessBin, secrets: { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, exec, now: () => now });
  assert.deepEqual(result.ran.map((t) => [t.task, t.status, t.filesChanged]), [['refund-crosses-month', 'finished', 1]]);
  const [trial] = trialsOf(base, p);
  assert.equal(trial.status, 'finished');
  assert.deepEqual(trial.modelsUsed, [MODEL]);
  assert.deepEqual(trial.roles, { builder: [MODEL], critic: [MODEL] });
  assert.deepEqual(trial.otherModels, []);
  assert.deepEqual(trial.harness, { name: 'claude-code', version: '2.1.323 (Claude Code)', binSha256: trial.harness.binSha256, coordinator: trial.harness.coordinator });
  assert.match(trial.harness.binSha256, /^[0-9a-f]{64}$/);
  // 100,000 input at 4, 1,000,000 cached at 0.20, 50,000 cache writes at 5 and 20,000 output at 20 USD a million: 0.40 + 0.20 + 0.25 + 0.40.
  assert.equal(trial.pinnedCost, 1.25);
  assert.deepEqual(trial.tokens, { input: 100_000, cachedInput: 1_000_000, cacheWrite: 50_000, output: 20_000 });
  assert.equal(trial.report.reportedCostUsd, 1.3);
  assert.equal(trial.diff.bytes, DIFF.length);
  assert.equal(result.spent, 1.25);

  const run = exec.calls.find((c) => c.args[0] === 'run' && c.args.at(-1) !== '--version');
  const text = run.args.join('\n');
  assert.match(run.args[run.args.indexOf('sh') - 1], /@sha256:[0-9a-f]{64}$/, 'the image is pinned by digest');
  for (const part of ['--rm', '--memory', '--plugin-dir', IN.plugin, '--max-budget-usd', '20', '--model', MODEL, '--effort', 'high', `CLAUDE_CODE_SUBAGENT_MODEL=${MODEL}`, `COORDINATOR_DIR=${IN.state}`]) assert.ok(run.args.includes(part), part);
  assert.ok(run.args.some((a) => a.endsWith(`:${IN.harness}:ro`)), 'the harness is mounted read-only');
  assert.match(text, /Use the coordinator skill/);
  assert.ok(run.args.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'the secret is passed by name');
  assert.ok(!text.includes(SECRET), 'never in an argument');
  assert.equal(run.opts.env.CLAUDE_CODE_OAUTH_TOKEN, SECRET, 'only in the docker client\'s environment');
  for (const f of allFiles(join(base, 'bench'))) assert.ok(!readFileSync(f, 'latin1').includes(SECRET), `${f} holds no secret`);
  assert.deepEqual(runPlan({ plan: p, base, harnessBin, exec, now: () => now }).ran, [], 'a task runs once');
});

test('the baseline arm is the model on its own: no plugin, no state folder', () => {
  const { base, harnessBin } = setup();
  const exec = docker();
  runPlan({ plan: plan({ arm: 'baseline' }), base, harnessBin, exec, now: () => now });
  const run = exec.calls.find((c) => c.args[0] === 'run' && c.args.at(-1) !== '--version');
  assert.ok(!run.args.includes('--plugin-dir'));
  assert.equal(hostOf(run.args, IN.state), null);
  assert.match(run.args.join('\n'), /You are working alone/);
});

test('a role or a call on another model is named in the record', () => {
  const { base, harnessBin } = setup();
  const p = plan();
  runPlan({ plan: p, base, harnessBin, exec: docker({ models: { ...usage(MODEL), 'claude-haiku-5-5': usage('x').x }, critic: 'claude-sonnet-5-5' }), now: () => now });
  const [trial] = trialsOf(base, p);
  assert.deepEqual(trial.otherModels, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(readClaudeReport(JSON.stringify({ modelUsage: usage(`${MODEL}[1m]`) })).modelsUsed[0], `${MODEL}[1m]`);
});

test('a secret found in the trial folder makes the trial invalid, and the record names the file, not the value', () => {
  const { base, harnessBin } = setup();
  const p = plan();
  runPlan({ plan: p, base, harnessBin, secrets: { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, exec: docker({ leakInto: 'credentials.json' }), now: () => now });
  const [trial] = trialsOf(base, p);
  assert.equal(trial.status, 'invalid');
  assert.match(trial.problem, /home\/credentials\.json/);
  assert.ok(!JSON.stringify(trial).includes(SECRET));
});

test('the cap is passed to the harness, and no new task starts once it is spent', () => {
  const { base, harnessBin } = setup();
  const exec = docker({ models: usage(MODEL, true) });
  const p = plan({ cap: '3 USD', task: 'refund-crosses-month,cursor-skips-ties,invoice-idor' });
  const result = runPlan({ plan: p, base, harnessBin, exec, now: () => now });
  // Each trial costs 0.40 + 0.20 + 0.25 + 4.00 = 4.85 at pinned prices, so the first one spends the cap.
  assert.deepEqual(result.ran.map((t) => t.task), ['cursor-skips-ties']);
  assert.match(result.stopped, /the cap of 3 USD is spent \(4\.85 USD at the suite's pinned prices\): no new task was started/);
  const run = exec.calls.find((c) => c.args[0] === 'run' && c.args.at(-1) !== '--version');
  assert.equal(run.args[run.args.indexOf('--max-budget-usd') + 1], '3');
  assert.ok(run.args.includes(`CEB_TIMEOUT_SECONDS=${timeoutMinutes(p.tasks[0]) * 60}`));
});

test('a run that was cut off is recorded as timed out and keeps its diff', () => {
  const { base, harnessBin } = setup();
  const p = plan();
  runPlan({ plan: p, base, harnessBin, exec: docker({ exit: '124' }), now: () => now });
  const [trial] = trialsOf(base, p);
  assert.equal(trial.status, 'timed-out');
  assert.equal(trial.diff.files, 1);
  assert.ok(statSync(join(trialDir(base, p.id, 'refund-crosses-month'), 'out', 'diff.patch')).size > 0);
});

test('nothing runs for a plan that is not confirmed, is ranked, or names no harness program', () => {
  const { base, harnessBin } = setup();
  const exec = docker();
  assert.throws(() => runPlan({ plan: plan({}, { confirmed: false }), base, harnessBin, exec }), /has not confirmed the estimate/);
  assert.throws(() => runPlan({ plan: plan({ mode: 'ranked', consent: 'yes', task: undefined }), base, harnessBin, exec }), /needs a ticket/);
  assert.throws(() => runPlan({ plan: plan(), base, harnessBin: null, exec }), /name the harness program/);
  assert.throws(() => runPlan({ plan: plan(), base, harnessBin: join(base, 'missing'), exec }), /no such harness program/);
  assert.throws(() => runPlan({ plan: plan({ harness: 'codex', model: 'gpt-6.1-sol' }), base, harnessBin, exec }), /codex is not wired up yet/);
  assert.equal(exec.calls.filter((c) => c.args.at(-1) !== '--version').length, 0, 'no container was started');
});

test('secrets come from named variables or a file outside the state folder', () => {
  const { base } = setup();
  assert.deepEqual(secretsFrom({ names: ['A_KEY'], env: { A_KEY: 'value-1' } }), { A_KEY: 'value-1' });
  assert.throws(() => secretsFrom({ names: ['A_KEY'], env: {} }), /A_KEY is not set in the environment/);
  assert.throws(() => secretsFrom({ names: ['not a name'], env: {} }), /not an environment variable name/);
  const outside = join(mkdtempSync(join(tmpdir(), 'ceb-env-')), 'bench.env');
  writeFileSync(outside, '# a comment\nA_KEY=value-2\nB_URL="http://host.docker.internal:11434"\n');
  assert.deepEqual(secretsFrom({ envFile: outside, base }), { A_KEY: 'value-2', B_URL: 'http://host.docker.internal:11434' });
  const inside = join(base, 'bench.env');
  writeFileSync(inside, 'A_KEY=value-3\n');
  assert.throws(() => secretsFrom({ envFile: inside, base }), /outside the state folder/);
});

test('the pure parts: prompts, harness arguments, docker arguments and the harness report', () => {
  for (const arm of ['coordinator', 'baseline']) for (const part of ['/task/ISSUE.md', '/task/BAR.md', 'ask nothing', 'do not push']) assert.ok(promptFor(arm, { model: MODEL }).includes(part), `${arm}: ${part}`);
  assert.match(promptFor('coordinator', { model: MODEL, maxRounds: 4 }), /at most 4 rounds[\s\S]*--model claude-opus-5-5/);
  assert.throws(() => harnessArgs('codex', {}), /not wired up yet/);
  assert.throws(() => dockerArgs({ name: 'n', image: 'ghcr.io/mindmakr/ceb-x:latest', mounts: [], env: {}, command: [] }), /pinned by digest/);
  assert.throws(() => dockerArgs({ name: 'n', image: `x@sha256:${'a'.repeat(64)}`, mounts: [], env: {}, secretNames: ['A=B'], command: [] }), /not an environment variable name/);
  assert.equal(readClaudeReport('not json'), null);
  const fromList = readClaudeReport(JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'error_max_budget_usd', usage: { input_tokens: 5, output_tokens: 7 } }]));
  assert.equal(fromList.isError, true);
  const notLoggedIn = readClaudeReport(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Not logged in · Please run /login', modelUsage: {} }));
  assert.deepEqual([notLoggedIn.isError, notLoggedIn.terminalReason, notLoggedIn.errorText], [true, 'api_error', 'Not logged in · Please run /login']);
  assert.equal(readClaudeReport(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'the work is done' })).errorText, null, 'what the model wrote is not copied');
  assert.deepEqual(fromList.tokens, { input: 5, cachedInput: 0, cacheWrite: 0, output: 7 });
  assert.equal(timeoutMinutes({ humanMinutes: 3 }), 20);
  assert.equal(timeoutMinutes({ humanMinutes: 30 }), 120);
});

test('run.mjs bench start refuses an unconfirmed plan before it looks for docker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceb-run-'));
  const cli = (...args) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', env: { ...process.env, COORDINATOR_DIR: dir } });
  const planned = JSON.parse(cli('bench', 'plan', '--model', MODEL, '--effort', 'high', '--cap', '20 USD', '--mode', 'practice', '--task', 'refund-crosses-month', '--manifest', FIXTURE, '--harness', 'claude-code').stdout);
  const r = cli('bench', 'start', planned.id, '--harness-bin', join(dir, 'missing'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has not confirmed the estimate/);
  cli('bench', 'confirm', planned.id, '--confirm', 'yes');
  assert.match(cli('bench', 'start', planned.id).stderr, /name the harness program/);
  assert.deepEqual(JSON.parse(cli('bench', 'show', planned.id).stdout).trials, []);
});
