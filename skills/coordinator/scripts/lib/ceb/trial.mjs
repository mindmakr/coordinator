// One CEB trial: one task, run once in its container by one configuration
// (references/ceb-bench.md). This file is the pure part: the prompt each arm
// gets, the command the harness is started with, the docker arguments, and how
// the harness's report and the run's state are read afterwards. Starting the
// container is lib/ceb/runner.mjs.
import { createHash } from 'node:crypto';
import { tokenCost } from './prices.mjs';

export const TRIAL_SCHEMA = 1;
// Where things are inside the container. /work and /task come with the task image.
export const IN = { harness: '/ceb/bin/harness', script: '/ceb/trial.sh', plugin: '/ceb/coordinator', home: '/ceb/home', out: '/out', state: '/state' };
export const LIMITS = { memory: '4g', cpus: '4', pids: '1024' };
const RUN_MJS = `${IN.plugin}/skills/coordinator/scripts/run.mjs`;

// A trial may take four times the task's expected human time, and never less than 20 minutes.
export const timeoutMinutes = (task) => Math.max(20, task.humanMinutes * 4);

// What the model is told. Both arms get the same task, bar and rules; only the way of working differs.
export function promptFor(arm, { model, maxRounds = 4 }) {
  const common = 'The task is in /task/ISSUE.md and the behaviours the work is judged by are in /task/BAR.md. The project is the git repository at /work; the command that runs its tests is in /task/task.json. Nobody is here to answer questions, so decide for yourself and ask nothing. There is no remote: do not push, open a pull request, merge or deploy. Leave the finished changes in the working tree of /work, and change nothing outside /work.';
  if (arm === 'baseline') return `You are working alone. ${common} Read the task and the bar, do the work, run the tests, and stop when the work meets the bar.`;
  return [
    `Use the coordinator skill and follow its \`run\` command for this task. ${common}`,
    'Every intake question is answered here:',
    '- The bar is every behaviour in /task/BAR.md, each marked by a fresh critic against the real code and the test output. The fence is the files under /work.',
    `- One unit, at most ${maxRounds} rounds. The builder works directly in /work on the current branch: no worktree, no branch, no pull request.`,
    `- Every role (lead, builder, critic) is ${model}: pass --model ${model} to \`run.mjs start\` and \`run.mjs verdict\`.`,
    `- The scripts are \`node ${RUN_MJS}\`, and the state folder is already set (COORDINATOR_DIR).`,
    '- Skip init, doctor, the dashboard, side studies and the retro.',
    'Stop when the run says the unit is done, or when the round budget is spent.',
  ].join('\n');
}

// The harness's own arguments, after its program path.
export function harnessArgs(harness, { arm, model, effort, capUsd, prompt }) {
  if (harness !== 'claude-code') throw new Error(`running tasks in ${harness} is not wired up yet; this version runs them in claude-code`);
  return [
    '-p', prompt,
    '--model', model,
    '--effort', effort,
    '--max-budget-usd', String(capUsd),
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    ...(arm === 'coordinator' ? ['--plugin-dir', IN.plugin] : []),
  ];
}

// Environment for the harness inside the container: every role and background call uses the model
// under test, and nothing phones home that is not the model call itself. No secret is set here.
export function harnessEnv({ arm, model }) {
  return {
    IS_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: IN.home,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    ...(arm === 'coordinator' ? { COORDINATOR_DIR: IN.state, COORDINATOR_HARNESS: 'claude-code' } : {}),
  };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function envName(n) {
  if (typeof n !== 'string' || !NAME.test(n)) throw new Error(`not an environment variable name: ${n}`);
  return n;
}

// `docker run` arguments for one trial. Secrets are passed by name only (`-e NAME`): their values travel
// in the docker client's environment, never in the argument list, a file or a log.
export function dockerArgs({ name, image, mounts, env, secretNames = [], command, limits = LIMITS }) {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`a task image must be pinned by digest, got: ${image}`);
  const args = ['run', '--rm', '--name', name, '--memory', limits.memory, '--cpus', limits.cpus, '--pids-limit', limits.pids];
  for (const m of mounts) args.push('-v', `${m.host}:${m.at}${m.readOnly ? ':ro' : ''}`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${envName(k)}=${v}`);
  for (const n of secretNames) args.push('-e', envName(n));
  return [...args, image, 'sh', IN.script, ...command];
}

const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
// What Claude Code's `-p --output-format json` report says: tokens (every model it used, sub-agents
// included), the models, its own cost figure and whether it ended in an error. Null when unreadable.
export function readClaudeReport(text) {
  let r;
  try { r = JSON.parse(String(text).trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch { return null; }
  if (Array.isArray(r)) r = r.findLast((e) => e && e.type === 'result') ?? null;
  if (!r || typeof r !== 'object') return null;
  const perModel = r.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage) : [];
  const tokens = perModel.length
    ? perModel.reduce((t, [, u]) => ({ input: t.input + int(u.inputTokens), cachedInput: t.cachedInput + int(u.cacheReadInputTokens), cacheWrite: t.cacheWrite + int(u.cacheCreationInputTokens), output: t.output + int(u.outputTokens) }), { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 })
    : { input: int(r.usage?.input_tokens), cachedInput: int(r.usage?.cache_read_input_tokens), cacheWrite: int(r.usage?.cache_creation_input_tokens), output: int(r.usage?.output_tokens) };
  return {
    isError: r.is_error === true || (typeof r.subtype === 'string' && r.subtype !== 'success'),
    subtype: typeof r.subtype === 'string' ? r.subtype : null,
    turns: int(r.num_turns),
    durationMs: int(r.duration_ms),
    apiMs: int(r.duration_api_ms),
    reportedCostUsd: Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null,
    sessionId: typeof r.session_id === 'string' ? r.session_id : null,
    modelsUsed: perModel.map(([m]) => m).sort(),
    tokens,
  };
}

// The models the Coordinator run recorded for each role, from its state snapshots: { builder: [...], critic: [...] }.
export function rolesFromStates(states) {
  const builder = new Set(); const critic = new Set();
  for (const s of states) for (const u of s?.units ?? []) {
    if (u.builtBy) builder.add(u.builtBy);
    for (const r of u.rounds ?? []) { if (r.builtBy) builder.add(r.builtBy); if (r.judgedBy) critic.add(r.judgedBy); }
  }
  return { builder: [...builder].sort(), critic: [...critic].sort() };
}

// A model name as the harness reports it, without a context-window suffix such as "[1m]".
const bare = (m) => String(m).replace(/\[[^\]]*\]$/, '');
// Names of anything that was not the model under test, across the harness report and the run's roles.
export function otherModels(model, report, roles = { builder: [], critic: [] }) {
  return [...new Set([...(report?.modelsUsed ?? []), ...roles.builder, ...roles.critic].filter((m) => bare(m) !== model))].sort();
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Files under the trial folder that hold one of the secret values. The values themselves are never returned.
export function leaks(files, secretValues) {
  const values = secretValues.filter((v) => typeof v === 'string' && v.length >= 8);
  return files.filter((f) => values.some((v) => f.text.includes(v))).map((f) => f.path).sort();
}

// The record of one finished trial. `status` is what happened to the run, not whether the task is solved:
// only the hidden grader says that.
export function trialRecord({ plan, task, price, per, harness, startedAt, endedAt, exit, timedOut, report, roles, diff, leaked }) {
  const status = leaked.length ? 'invalid' : timedOut ? 'timed-out' : !report || report.isError || exit !== 0 ? 'harness-error' : 'finished';
  return {
    schema: TRIAL_SCHEMA,
    plan: plan.id,
    suite: plan.suite,
    task: task.id,
    image: task.image,
    arm: plan.config.arm,
    model: plan.config.model,
    effort: plan.config.effort,
    serving: plan.config.serving,
    harness,
    startedAt,
    endedAt,
    wallMs: Date.parse(endedAt) - Date.parse(startedAt),
    exit,
    timedOut,
    status,
    ...(leaked.length ? { problem: `a secret value was found in ${leaked.length} file${leaked.length === 1 ? '' : 's'} of the trial folder: ${leaked.join(', ')}` } : {}),
    report: report ? { isError: report.isError, subtype: report.subtype, turns: report.turns, durationMs: report.durationMs, apiMs: report.apiMs, reportedCostUsd: report.reportedCostUsd, sessionId: report.sessionId } : null,
    tokens: report?.tokens ?? null,
    pinnedCost: report && price ? tokenCost(price, report.tokens, per) : null,
    modelsUsed: report?.modelsUsed ?? [],
    roles,
    otherModels: otherModels(plan.config.model, report, roles),
    diff,
  };
}
