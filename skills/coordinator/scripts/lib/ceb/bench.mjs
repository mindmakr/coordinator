// CEB intake, cost estimate and plan (references/ceb-bench.md). A benchmark run
// is planned first: the configuration is checked, the tasks come from the
// verified manifest, and an estimate at the suite's pinned prices is shown.
// Nothing may start until the person has confirmed that estimate. Pure.
import { priceOf, pricedModels, tokenCost } from './prices.mjs';

export const HARNESSES = ['claude-code', 'codex'];
export const EFFORTS = { 'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
export const MODES = ['practice', 'ranked'];
// coordinator: the task runs through the Coordinator loop (lead, builder, blind critic). baseline: the same
// model does the task on its own in the same tool, one session, so the board can show what the loop adds.
export const ARMS = ['coordinator', 'baseline'];
export const DEFAULT_SERVING = 'vendor-api';
const SERVING = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CAP_MAX = 100_000;

// What a run is assumed to use, per minute of a task's expected human time and per round
// (lead, builder and critic together), until measured runs replace the figures: `measured`
// says which. `rounds` is the expected number of rounds a task takes, `maxRounds` the run's cap.
// `baselineShare` is the part of one round's tokens the model is assumed to use working alone.
export const BASIS = {
  'CEB-2026.12': { measured: false, perHumanMinute: { input: 6_000, cachedInput: 60_000, output: 1_000 }, rounds: 2, maxRounds: 4, baselineShare: 0.6 },
};

// The basis for one arm: the baseline is one session, so one "round" at its share of the tokens.
export function basisFor(basis, arm = 'coordinator') {
  if (arm !== 'baseline') return basis;
  const perHumanMinute = Object.fromEntries(Object.entries(basis.perHumanMinute).map(([k, v]) => [k, Math.round(v * basis.baselineShare)]));
  return { ...basis, perHumanMinute, rounds: 1, maxRounds: 1 };
}

const round2 = (n) => Math.round(n * 100) / 100;
const own = (o, k) => Object.hasOwn(o, k);
const given = (v) => typeof v === 'string' && v.trim() !== '';

// Names that point at "whichever model is newest": a result under one cannot be compared later.
const ALIAS_WORDS = new Set(['latest', 'default', 'best', 'auto', 'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'opusplan', 'gpt', 'codex', 'gemini', 'grok', 'qwen', 'llama', 'deepseek']);
export function isAlias(model) {
  const m = String(model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  return ALIAS_WORDS.has(m) || /(^|[-_.:/@])latest($|[-_.:/@])/.test(m);
}

export function modelProblem(model, list, suite) {
  if (!given(model)) return 'a model is required: --model <exact model id> (run.mjs bench prices lists them)';
  const priced = `Priced in ${suite}: ${pricedModels(list).join(', ')}`;
  if (isAlias(model)) return `${model} is an alias: it can point at a different model tomorrow, so a result under it could not be compared. Give the exact model id. ${priced}`;
  if (!priceOf(list, model)) return `${model} has no pinned price in suite ${suite}, so its cost could not be compared. ${priced}`;
  return null;
}

// "20 USD" or "USD 20": the most the run may spend at the suite's pinned prices.
export function capOf(v, currency = 'USD') {
  if (!given(v)) throw new Error(`a spending cap is required: --cap "20 ${currency}" (the most this run may spend at the suite's pinned prices)`);
  const s = v.trim();
  const m = /^(\d+(?:\.\d{1,2})?)\s*([A-Za-z]{3})$/.exec(s) ?? /^([A-Za-z]{3})\s*(\d+(?:\.\d{1,2})?)$/.exec(s);
  if (!m) throw new Error(`--cap must be an amount and a currency, e.g. "20 ${currency}", got: ${v}`);
  const [amount, code] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
  if (code.toUpperCase() !== currency) throw new Error(`--cap must be in ${currency}, the currency of the suite's price list, got: ${code}`);
  if (!(amount > 0) || amount > CAP_MAX) throw new Error(`--cap must be more than 0 and at most ${CAP_MAX} ${currency}, got: ${v}`);
  return { amount, currency };
}

// The tasks of this run: all of the manifest's, or the ones named (a,b or repeated), in manifest order.
export function pickTasks(manifest, names) {
  const wanted = (Array.isArray(names) ? names : names === undefined ? [] : [names]).flatMap((n) => String(n).split(',')).map((n) => n.trim()).filter(Boolean);
  if (!wanted.length) return manifest.tasks;
  const known = new Set(manifest.tasks.map((t) => t.id));
  const unknown = wanted.filter((n) => !known.has(n));
  if (unknown.length) throw new Error(`not a task of ${manifest.suite}: ${unknown.join(', ')} (tasks: ${[...known].join(', ')})`);
  return manifest.tasks.filter((t) => wanted.includes(t.id));
}

// The checked configuration and tasks of a run, from the command's options. Every problem is
// reported at once, in plain words, so the person answers them in one go.
export function intake(o, { manifest, list, harness }) {
  const problems = [];
  const attempt = (fn) => { try { return fn(); } catch (e) { problems.push(e.message); return null; } };
  const suite = manifest.suite;

  const mp = modelProblem(o.model, list, suite);
  if (mp) problems.push(mp);
  const price = mp ? null : priceOf(list, o.model);

  if (!HARNESSES.includes(harness)) problems.push(`the bench runs in Claude Code or Codex, and this command ran in ${harness ?? 'an unknown tool'}: pass --harness claude-code or --harness codex`);
  const efforts = EFFORTS[harness] ?? [...new Set(Object.values(EFFORTS).flat())];
  if (!given(o.effort)) problems.push(`an effort level is required: --effort ${efforts.join('|')}`);
  else if (!efforts.includes(o.effort)) problems.push(`--effort must be one of ${efforts.join(', ')}${own(EFFORTS, harness) ? ` for ${harness}` : ''}, got: ${o.effort}`);

  const cap = attempt(() => capOf(o.cap, list.currency));

  if (!given(o.mode)) problems.push('say which kind of run: --mode practice (never reaches the board) or --mode ranked');
  else if (!MODES.includes(o.mode)) problems.push(`--mode must be practice or ranked, got: ${o.mode}`);
  const ranked = o.mode === 'ranked';
  const arm = o.arm === undefined ? 'coordinator' : o.arm;
  if (!ARMS.includes(arm)) problems.push(`--arm must be coordinator (through the Coordinator loop) or baseline (the model on its own), got: ${o.arm}`);

  if (o.consent !== undefined && !['yes', 'no'].includes(o.consent)) problems.push(`--consent must be yes or no, got: ${o.consent}`);
  if (ranked && o.consent !== 'yes') problems.push('a ranked result is published under your GitHub handle: it needs --consent yes, given by the person');
  if (ranked && o.task !== undefined) problems.push('in a ranked run the service picks the tasks: leave out --task');

  let serving = DEFAULT_SERVING;
  if (o.serving !== undefined) {
    if (!given(o.serving) || !SERVING.test(o.serving)) problems.push(`--serving must be a short name for how the model is served (e.g. vendor-api, openrouter, ollama-q4_k_m), got: ${o.serving}`);
    else serving = o.serving;
  } else if (price?.openWeights) {
    problems.push(`${o.model} is an open-weight model, and a quantised or third-party copy is not the same model: say how it is served, --serving <vendor-api | the host | the runtime and quantisation, e.g. ollama-q4_k_m>`);
  }

  const tasks = attempt(() => pickTasks(manifest, ranked ? undefined : o.task)) ?? [];
  if (problems.length) throw new Error(problems.join('\n'));
  return {
    config: { model: o.model, harness, effort: o.effort, arm, serving, mode: o.mode, cap, consent: ranked ? true : o.consent === undefined ? null : o.consent === 'yes' },
    tasks: tasks.map((t) => ({ id: t.id, category: t.category, image: t.image, humanMinutes: t.humanMinutes })),
    price,
  };
}

// The cost of these tasks at one model's pinned prices: `expected` at the basis's usual number of
// rounds, `high` if every task takes the round cap. Derived from assumed tokens unless the basis is measured.
export function estimate(tasks, price, basis, { currency = 'USD', per = 1_000_000 } = {}) {
  const tokens = (minutes, rounds) => Object.fromEntries(Object.entries(basis.perHumanMinute).map(([k, v]) => [k, v * minutes * rounds]));
  const perTask = tasks.map((t) => ({
    id: t.id,
    humanMinutes: t.humanMinutes,
    expected: tokenCost(price, tokens(t.humanMinutes, basis.rounds), per),
    high: tokenCost(price, tokens(t.humanMinutes, basis.maxRounds), per),
  }));
  const minutes = tasks.reduce((n, t) => n + t.humanMinutes, 0);
  return {
    currency,
    expected: round2(perTask.reduce((n, t) => n + t.expected, 0)),
    high: round2(perTask.reduce((n, t) => n + t.high, 0)),
    rounds: basis.rounds,
    maxRounds: basis.maxRounds,
    measured: basis.measured,
    tokens: tokens(minutes, basis.rounds),
    perTask,
  };
}

// The sentences the person reads before deciding.
export function estimateText(est, cap, arm = 'coordinator') {
  const n = est.perTask.length;
  const tasks = `${n} task${n === 1 ? '' : 's'}`;
  const lines = [
    arm === 'baseline'
      ? `About ${est.expected} ${est.currency} for ${tasks} at the suite's pinned prices, with the model working on its own (no Coordinator loop).`
      : `About ${est.expected} ${est.currency} for ${tasks} at the suite's pinned prices (${est.rounds} rounds a task), up to ${est.high} ${est.currency} if every task takes ${est.maxRounds} rounds.`,
    est.measured ? 'From measured runs of this suite.' : 'This is an estimate from assumed token counts, not a measurement; the first real runs will replace it.',
    `Your cap is ${cap.amount} ${cap.currency}: the run starts no new ${arm === 'baseline' ? 'task' : 'round'} once it has spent that much.`,
  ];
  if (est.expected > cap.amount) lines.push(`The estimate is above your cap, so some tasks will probably not finish; an unfinished task counts as not solved.`);
  return lines;
}

// A model in a tool its maker does not document for it: allowed, and said, because it changes how exact the cost is.
export function routeNote(config, price) {
  if (config.harness === 'claude-code' && price.vendor !== 'Anthropic') return 'Claude Code is documented for Claude models only. With another model its token counts can be estimates, so the cost on the board is less exact; Codex is the documented route (references/ceb-bench.md).';
  if (config.harness === 'codex' && price.vendor === 'Anthropic') return 'Codex does not reach Claude models without a translating proxy in between; Claude Code is the documented route (references/ceb-bench.md).';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
// bench-20261113-081530 (UTC), with -2, -3 … when that second is taken.
export function benchId(now, taken = () => false) {
  const base = `bench-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const SCHEMA = 1;

// The record of a planned run: what will run, what it should cost, and that nobody has agreed yet.
export function planOf({ id, now, opened, config, tasks, est, by = null }) {
  return {
    schema: SCHEMA,
    id,
    suite: opened.manifest.suite,
    createdAt: now.toISOString(),
    manifest: { sha256: opened.sha256, keyId: opened.keyId },
    config,
    tasks,
    estimate: est,
    status: 'planned',
    confirmed: null,
    ...(by ? { plannedBy: by } : {}),
  };
}

// The person agreed to the estimate, in their words. Only a planned run can be confirmed, once.
export function confirmPlan(record, words, now) {
  if (record?.schema !== SCHEMA) throw new Error('not a bench plan this version can read');
  if (record.status !== 'planned') throw new Error(`${record.id} is already ${record.status}`);
  if (!given(words)) throw new Error('the person\'s go-ahead is required, in their words: --confirm "yes, run it"');
  return { ...record, status: 'confirmed', confirmed: { at: now.toISOString(), words } };
}

// Why this run may not start yet, or null when it may. Every step that calls a model asks this first.
export function startRefusal(record) {
  if (record?.schema !== SCHEMA) return 'not a bench plan this version can read';
  if (record.status !== 'confirmed' || !record.confirmed) return `the person has not confirmed the estimate of ${record.id}: show it to them, then run.mjs bench confirm ${record.id} --confirm "<their words>"`;
  if (record.config.mode === 'ranked') return 'a ranked run needs a ticket from the benchmark service, which this version cannot ask for yet: plan a practice run';
  return null;
}
