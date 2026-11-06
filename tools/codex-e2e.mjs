#!/usr/bin/env node
// End-to-end check of the skill in OpenAI Codex CLI. Manual: not part of npm test,
// because it needs `codex` signed in and spends the person's model quota.
//
//   node tools/codex-e2e.mjs --dir <empty scratch folder> [--minutes 25] [--model M]
//        [--sandbox workspace-write|danger-full-access]
//
// It makes a small git project with one failing test, installs every skill folder into
// its .agents/skills/ with the AGENTS.md block from references/codex.md, asks `codex exec`
// to run the task through the coordinator skill, then checks the run's own log: the run
// closed done, every unit passed after a build and a verdict, and the test passes unchanged.
// Everything stays under --dir (the run's state is <dir>/project/.coordinator).
// On Windows, Codex's workspace-write sandbox may not reach a Node installed through a
// symlink (nvm); then pass --sandbox danger-full-access, which is safe only because the
// project is a throwaway folder.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, readRun } from '../skills/coordinator/scripts/lib/events.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const root = opt('dir') && resolve(opt('dir'));
if (!root) { console.error('usage: codex-e2e.mjs --dir <empty scratch folder> [--minutes 25] [--model M] [--sandbox mode]'); process.exit(2); }
if (existsSync(root) && readdirSync(root).length) { console.error(`${root} is not empty`); process.exit(2); }
const minutes = Number(opt('minutes', '25'));
const sandbox = opt('sandbox', 'workspace-write');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'project');
const state = join(project, '.coordinator');
const RUN = 'codex-e2e';

const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: project, encoding: 'utf8', ...o });
const version = sh('codex', ['--version'], { cwd: undefined });
if (version.status !== 0) { console.error('codex is not installed: npm i -g @openai/codex, then codex login'); process.exit(3); }

// The project: a sum that drops cents, and a test that says so.
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'codex-e2e', private: true, type: 'module', scripts: { test: 'node --test sum.test.mjs' } }, null, 2)}\n`);
writeFileSync(join(project, 'sum.mjs'), 'export const total = (cents) => cents.reduce((a, c) => a + Math.floor(c / 100) * 100, 0);\n');
writeFileSync(join(project, 'sum.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { total } from './sum.mjs';\n\ntest('total keeps every cent', () => assert.equal(total([150, 275]), 425));\n");
writeFileSync(join(project, '.gitignore'), '.coordinator/\n');
const block = readFileSync(join(repo, 'skills/coordinator/references/codex.md'), 'utf8').match(/## AGENTS\.md block[\s\S]*?```\n([\s\S]*?)```/)[1];
writeFileSync(join(project, 'AGENTS.md'), `# Project\n\nRun the tests with \`npm test\`.\n\n${block}`);
for (const s of readdirSync(join(repo, 'skills'))) cpSync(join(repo, 'skills', s), join(project, '.agents/skills', s), { recursive: true });
for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'start']]) sh('git', a);
if (sh(process.execPath, ['--test', 'sum.test.mjs']).status === 0) { console.error('the starting test should fail'); process.exit(1); }

const prompt = [
  `Use the coordinator skill to run this task as run \`${RUN}\`, with COORDINATOR_DIR=${state}.`,
  'Task: `npm test` fails because `total` in sum.mjs drops cents. Fix it.',
  'Every question is answered already: one unit; the bar is "npm test passes, with the existing test unchanged"; the fence is sum.mjs only;',
  'budget 2 rounds and 20 minutes; work in this folder on main; no merge, push, PR or anything outside this folder.',
  'Do not ask me anything. Run the loop to the end with the run.mjs script, then close the run.',
].join(' ');
const t0 = Date.now();
const codex = sh('codex', ['exec', '--cd', project, '--sandbox', sandbox, '--add-dir', root, '-c', 'shell_environment_policy.inherit=all',
  '--json', '-o', join(root, 'last-message.txt'), ...(opt('model') ? ['-m', opt('model')] : []), prompt],
  { env: { ...process.env, COORDINATOR_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'], timeout: minutes * 60_000, maxBuffer: 256 * 1024 * 1024 });
writeFileSync(join(root, 'codex.jsonl'), codex.stdout ?? '');

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
const limit = (codex.stdout ?? '').match(/"message":"([^"]*usage limit[^"]*)"/);
check('codex exec finished', codex.status === 0, limit?.[1] ?? codex.error?.message ?? (codex.stderr ?? '').trim().split('\n').slice(-3).join(' | '));
const runDir = join(state, 'runs', RUN);
let kinds = [];
try {
  const { state: s } = readRun(runDir) ?? (() => { throw new Error('codex wrote no run'); })();
  kinds = parseLog(readFileSync(join(runDir, 'events.jsonl'))).events.map((e) => e.kind);
  check('the run closed done', s.closed?.outcome === 'done', JSON.stringify(s.closed ?? null));
  check('every unit passed', s.units.length > 0 && s.units.every((u) => u.status === 'pass'), s.units.map((u) => `${u.id}:${u.status}`).join(' '));
  for (const k of ['run.freeze', 'unit.start', 'unit.built', 'unit.verdict', 'run.close']) check(`the log has ${k}`, kinds.includes(k));
  check('built before the verdict', kinds.indexOf('unit.built') > -1 && kinds.indexOf('unit.built') < kinds.lastIndexOf('unit.verdict'));
} catch (e) { check('the run log loads', false, e.message); }
check('the test passes', sh(process.execPath, ['--test', 'sum.test.mjs']).status === 0);
check('the test file is unchanged', sh('git', ['diff', '--quiet', 'HEAD', '--', 'sum.test.mjs']).status === 0);
const subAgents = /"(spawn_agent|collab_tool_call|agent_spawn)/.test(codex.stdout ?? '');

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, codex: version.stdout.trim(), minutes: Math.round((Date.now() - t0) / 6000) / 10, subAgents, events: kinds.length, checks, transcript: join(root, 'codex.jsonl') }, null, 2));
process.exit(ok ? 0 : 1);
