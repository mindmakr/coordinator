// .coordinator/coordinator.json: per-machine settings, written by `init` and
// checked by `doctor`. Every key is optional; a missing file means defaults.
//   visibility  private | internal | public   (else `gh` is asked at push)
//   state       local | repo                  (local: run state never leaves this machine)
//   stateRepo   private companion repo for run state (owner/name or URL)
//   remote, branch                            where `push` writes (origin, coordinator-state)
//   service     the hosted app's URL (https; http only on localhost)
//   theme       the dashboard's CSS theme file (COORDINATOR.md `Theme:` wins)
//   budgets     { rounds 1-8, minutes 5-10080 }: defaults for `run.mjs init`
//   merge       branches a run may merge into when the review passes ([] = PR only)
//               (also launchMinutes 1-600, launchCost "0.50 USD": caps for one agent launch)
//   models      false (routing off) or { strong, critic, specialist, visual-critic, integrator,
//               builder, researcher, mechanical, or a task class: model name }
//   helpers     small models for small jobs (lib/helpers.mjs, references/helpers.md)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { launchCostProblem } from './cost.mjs';
import { checkHelpers } from './helpers.mjs';

export const KEYS = ['visibility', 'state', 'stateRepo', 'remote', 'branch', 'service', 'theme', 'budgets', 'merge', 'models', 'helpers'];
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const name = (v) => typeof v === 'string' && v.trim() !== '' && !v.startsWith('-');
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
// Roles that judge: they must not run on a weaker model than `strong`.
export const JUDGES = ['critic', 'specialist', 'visual-critic', 'integrator'];
// Higher is stronger; unknown names are not compared.
const RANK = [['haiku', 1], ['sonnet', 2], ['opus', 3]];
const rank = (m) => RANK.find(([k]) => String(m).toLowerCase().includes(k))?.[1] ?? null;

export const settingsFile = (base) => join(base, 'coordinator.json');

// { settings, error }: error is a message when the file exists but is not a JSON object.
export function readSettings(base) {
  const file = settingsFile(base);
  if (!existsSync(file)) return { settings: {}, missing: true };
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return isObj(s) ? { settings: s } : { settings: {}, error: 'expected a JSON object' };
  } catch (e) { return { settings: {}, error: `not valid JSON (${e.message.split('\n')[0]})` }; }
}

export const serviceProblem = (service) => {
  let url;
  try { url = new URL(service); } catch { return 'not a URL'; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'must be https (http only on localhost)';
  if (url.username || url.password) return 'must not carry a user or password';
  return null;
};

// Problems with each key: [{ key, level: 'fail'|'warn', text }]. Paths resolve against `project`.
export function checkSettings(s, project) {
  const out = [];
  const bad = (key, text, level = 'fail') => out.push({ key, level, text });
  for (const k of Object.keys(s)) if (!KEYS.includes(k)) bad(k, `unknown key "${k}" (known: ${KEYS.join(', ')})`, 'warn');
  if (s.visibility !== undefined && !['private', 'internal', 'public'].includes(s.visibility)) bad('visibility', 'visibility must be private, internal or public');
  if (s.state !== undefined && !['local', 'repo'].includes(s.state)) bad('state', 'state must be local or repo');
  for (const k of ['stateRepo', 'remote', 'branch']) if (s[k] !== undefined && !name(s[k])) bad(k, `${k} must be a non-empty string`);
  if (s.branch !== undefined && ['main', 'master', 'HEAD'].includes(s.branch)) bad('branch', `run state never goes to ${s.branch}`);
  if (s.visibility === 'public' && s.state !== 'local' && !s.stateRepo) bad('stateRepo', 'the repo is public: set stateRepo to a private companion repo, or state to local');
  if (s.service !== undefined) { const p = typeof s.service === 'string' ? serviceProblem(s.service) : 'must be a string'; if (p) bad('service', `service ${p}`); }
  if (s.theme !== undefined) {
    const f = typeof s.theme === 'string' && s.theme ? (isAbsolute(s.theme) ? s.theme : resolve(project, s.theme)) : '';
    if (!f || extname(f).toLowerCase() !== '.css') bad('theme', 'theme must name a .css file');
    else if (!existsSync(f) || !statSync(f).isFile()) bad('theme', `theme file not found: ${s.theme}`);
  }
  if (s.budgets !== undefined) {
    if (!isObj(s.budgets)) bad('budgets', 'budgets must be an object { rounds, minutes }');
    else {
      const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
      if (s.budgets.rounds !== undefined && !whole(s.budgets.rounds, 1, 8)) bad('budgets', 'budgets.rounds must be a whole number 1-8');
      if (s.budgets.minutes !== undefined && !whole(s.budgets.minutes, 5, 10_080)) bad('budgets', 'budgets.minutes must be a whole number 5-10080');
      if (s.budgets.launchMinutes !== undefined && !whole(s.budgets.launchMinutes, 1, 600)) bad('budgets', 'budgets.launchMinutes must be a whole number 1-600');
      if (s.budgets.launchCost !== undefined && (typeof s.budgets.launchCost !== 'string' || launchCostProblem(s.budgets.launchCost))) bad('budgets', `budgets.launchCost ${typeof s.budgets.launchCost === 'string' ? launchCostProblem(s.budgets.launchCost) : 'must be an amount and a currency, like "0.50 USD"'}`);
    }
  }
  if (s.helpers !== undefined) for (const p of checkHelpers(s.helpers)) bad('helpers', p.text, p.level);
  if (s.merge !== undefined) {
    if (!Array.isArray(s.merge) || !s.merge.every((b) => typeof b === 'string' && BRANCH.test(b) && !b.startsWith('-'))) bad('merge', 'merge must be a list of branch names ([] = open the PR only)');
    else for (const b of s.merge) if (['main', 'master', 'production', 'prod'].includes(b)) bad('merge', `merge allows "${b}": a release branch usually needs a person`, 'warn');
  }
  if (s.models !== undefined && s.models !== false) {
    if (!isObj(s.models) || !Object.values(s.models).every(name)) bad('models', 'models must be false or { role: model name }');
    else {
      const strong = rank(s.models.strong);
      for (const role of JUDGES) {
        const r = rank(s.models[role]);
        if (strong !== null && r !== null && r < strong) bad('models', `${role} (${s.models[role]}) is below strong (${s.models.strong}); routing ignores that and keeps judges at strong`, 'warn');
      }
    }
  }
  return out;
}
