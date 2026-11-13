// Runs the trials of a confirmed CEB plan (references/ceb-bench.md): for each task, one
// container from the task's image, with the harness mounted in read-only, the model under
// test in every role, and the spending cap passed to the harness. What comes back is the
// diff, the harness's report and, for the coordinator arm, the run's state.
//
// Secrets (an API key, a subscription token) are read from the runner's environment or from a
// file the runner names, handed to docker in its environment only, and never written, printed
// or put in an argument. After each trial the trial folder is searched for their values; a
// trial that holds one is marked invalid.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, safeId, writeJson } from '../store.mjs';
import { VERSION } from '../version.mjs';
import { BASIS, startRefusal } from './bench.mjs';
import { priceList, priceOf } from './prices.mjs';
import { dockerArgs, envName, harnessArgs, harnessEnv, IN, leaks, promptFor, readClaudeReport, rolesFromStates, sha256, timeoutMinutes, trialRecord } from './trial.mjs';

const SCRIPT = fileURLToPath(new URL('./container/trial.sh', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PLUGIN_PARTS = ['.claude-plugin', 'skills', 'commands'];
const round2 = (n) => Math.round(n * 100) / 100;

export const trialsDir = (base, planId) => join(base, 'bench', safeId(planId, 'bench id'), 'trials');
export const trialDir = (base, planId, taskId) => join(trialsDir(base, planId), safeId(taskId, 'task id'));
const trialFile = (base, planId, taskId) => join(trialDir(base, planId, taskId), 'trial.json');

// The trials of a plan that have finished, in the plan's task order.
export function trialsOf(base, plan) {
  return plan.tasks.map((t) => trialFile(base, plan.id, t.id)).filter(existsSync).map((f) => readJson(f, null));
}

// name → value for every secret the runner passes: the named variables of the environment, and the
// NAME=value lines of a file kept outside the state folder. Values go nowhere but docker's environment.
export function secretsFrom({ names = [], envFile = null, env = process.env, base }) {
  const out = {};
  for (const n of names) {
    envName(n);
    if (typeof env[n] !== 'string' || env[n] === '') throw new Error(`${n} is not set in the environment`);
    out[n] = env[n];
  }
  if (envFile) {
    const file = resolve(envFile);
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`no such file: ${envFile}`);
    if (base && (file + sep).startsWith(resolve(base) + sep)) throw new Error('keep the env file outside the state folder: a secret never lives beside a run');
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) throw new Error(`${envFile}: every line must be NAME=value`);
      out[envName(line.slice(0, eq).trim())] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return out;
}

function walk(dir, files = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, files); else if (e.isFile()) files.push(p);
  }
  return files;
}

const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

// The harness's name, version (asked inside the task image, which also proves the program runs there) and hash.
export function harnessInfo({ harness, harnessBin, image, exec = spawnSync }) {
  const bin = resolve(harnessBin);
  if (!existsSync(bin) || !statSync(bin).isFile()) throw new Error(`no such harness program: ${harnessBin} (the Linux build of the harness, as one file)`);
  const r = exec('docker', ['run', '--rm', '-v', `${bin}:${IN.harness}:ro`, image, IN.harness, '--version'], { encoding: 'utf8', timeout: 120_000 });
  if (r.error) throw new Error(`could not start docker: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the harness program does not run in ${image.split('@')[0]}: ${String(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.status}`}`);
  return { name: harness, version: String(r.stdout).trim().split(/\r?\n/)[0].slice(0, 80), binSha256: sha256(readFileSync(bin)), coordinator: VERSION };
}

// One trial: start the container, wait for it, read what it left, and write trial.json.
export function runTrial({ plan, task, base, harnessBin, harness, secrets = {}, capUsd, exec = spawnSync, now = () => new Date() }) {
  const dir = trialDir(base, plan.id, task.id);
  if (existsSync(join(dir, 'trial.json'))) throw new Error(`${task.id} already ran in ${plan.id}`);
  const paths = { out: join(dir, 'out'), home: join(dir, 'home'), state: join(dir, 'state') };
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });
  const { arm, model, effort } = plan.config;
  const list = priceList(plan.suite);
  const limitSeconds = timeoutMinutes(task) * 60;

  const mounts = [
    { host: resolve(harnessBin), at: IN.harness, readOnly: true },
    { host: SCRIPT, at: IN.script, readOnly: true },
    { host: paths.out, at: IN.out },
    { host: paths.home, at: IN.home },
  ];
  if (arm === 'coordinator') {
    if (!existsSync(join(PLUGIN_ROOT, '.claude-plugin'))) throw new Error('the coordinator arm needs the Coordinator plugin, and this copy of the skill is not inside one');
    for (const part of PLUGIN_PARTS) mounts.push({ host: join(PLUGIN_ROOT, part), at: `${IN.plugin}/${part}`, readOnly: true });
    mounts.push({ host: paths.state, at: IN.state });
  }
  const prompt = promptFor(arm, { model, maxRounds: BASIS[plan.suite]?.maxRounds ?? 4 });
  const args = dockerArgs({
    name: `ceb-${plan.id}-${task.id}`,
    image: task.image,
    mounts,
    env: { ...harnessEnv({ arm, model }), CEB_TIMEOUT_SECONDS: String(limitSeconds) },
    secretNames: Object.keys(secrets),
    command: harnessArgs(plan.config.harness, { arm, model, effort, capUsd, prompt }),
  });

  const startedAt = now().toISOString();
  const r = exec('docker', args, { env: { ...process.env, ...secrets }, encoding: 'utf8', timeout: (limitSeconds + 180) * 1000, maxBuffer: 16 * 1024 * 1024 });
  const killed = r.error?.code === 'ETIMEDOUT';
  if (killed) exec('docker', ['kill', `ceb-${plan.id}-${task.id}`], { encoding: 'utf8', timeout: 60_000 });
  else if (r.error) throw new Error(`could not start docker: ${r.error.message}`);
  const endedAt = now().toISOString();

  const exitText = readIf(join(paths.out, 'exit')).trim();
  const exit = /^\d+$/.test(exitText) ? Number(exitText) : (r.status ?? -1);
  const patch = existsSync(join(paths.out, 'diff.patch')) ? readFileSync(join(paths.out, 'diff.patch')) : Buffer.alloc(0);
  const states = existsSync(join(paths.state, 'runs'))
    ? readdirSync(join(paths.state, 'runs')).map((n) => join(paths.state, 'runs', n, 'state.json')).filter(existsSync).map((f) => { try { return readJson(f, null); } catch { return null; } })
    : [];
  const leaked = leaks(walk(dir).map((p) => ({ path: p.slice(dir.length + 1).split(sep).join('/'), text: readFileSync(p, 'latin1') })), Object.values(secrets));
  const record = trialRecord({
    plan, task, price: priceOf(list, model), per: list.per, harness, startedAt, endedAt,
    exit, timedOut: killed || exit === 124,
    report: readClaudeReport(readIf(join(paths.out, 'harness.out'))),
    roles: rolesFromStates(states),
    diff: { bytes: patch.length, sha256: sha256(patch), files: (patch.toString('latin1').match(/^diff --git /gm) ?? []).length },
    leaked,
  });
  writeJson(join(dir, 'trial.json'), record);
  return record;
}

const brief = (t) => ({ task: t.task, status: t.status, minutes: Math.round(t.wallMs / 6000) / 10, turns: t.report?.turns ?? null, pinnedCost: t.pinnedCost, filesChanged: t.diff.files, ...(t.otherModels.length ? { otherModels: t.otherModels } : {}), ...(t.problem ? { problem: t.problem } : {}) });

// Every task of the plan that has not run yet, one after another, until the tasks or the cap run out.
export function runPlan({ plan, base, harnessBin, secrets = {}, only = null, exec = spawnSync, now = () => new Date(), onTrial = () => {} }) {
  const refusal = startRefusal(plan);
  if (refusal) throw new Error(refusal);
  if (!harnessBin) throw new Error('name the harness program: --harness-bin <the Linux build of the harness, as one file> (references/ceb-bench.md)');
  const wanted = only?.length ? plan.tasks.filter((t) => only.includes(t.id)) : plan.tasks;
  const unknown = (only ?? []).filter((id) => !plan.tasks.some((t) => t.id === id));
  if (unknown.length) throw new Error(`not a task of this plan: ${unknown.join(', ')}`);
  const cap = plan.config.cap;
  const done = trialsOf(base, plan);
  let spent = done.reduce((n, t) => n + (t.pinnedCost ?? 0), 0);
  const ran = [];
  let stopped = null;
  let harness = null;
  for (const task of wanted) {
    if (done.some((t) => t.task === task.id)) continue;
    const remaining = round2(cap.amount - spent);
    if (remaining <= 0) { stopped = `the cap of ${cap.amount} ${cap.currency} is spent (${round2(spent)} ${cap.currency} at the suite's pinned prices): no new task was started`; break; }
    harness ??= harnessInfo({ harness: plan.config.harness, harnessBin, image: task.image, exec });
    const record = runTrial({ plan, task, base, harnessBin, harness, secrets, capUsd: remaining, exec, now });
    spent += record.pinnedCost ?? 0;
    ran.push(record);
    onTrial(record);
  }
  return { plan: plan.id, arm: plan.config.arm, model: plan.config.model, ran: ran.map(brief), spent: round2(spent), cap, ...(stopped ? { stopped } : {}), trials: trialsDir(base, plan.id) };
}

export const trialBrief = brief;
