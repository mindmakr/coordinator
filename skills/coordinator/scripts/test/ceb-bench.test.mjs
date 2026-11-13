// run.mjs bench (references/ceb-bench.md): the intake refuses an alias, an unpriced model and a
// missing cap; the estimate is tokens times the suite's pinned prices; nothing may start before
// the person confirms; and the manifest is fetched from one fixed place and verified.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASIS, basisFor, benchId, capOf, confirmPlan, EFFORTS, estimate, intake, isAlias, planOf, routeNote, startRefusal } from '../lib/ceb/bench.mjs';
import { BENCH_FLAGS } from '../lib/ceb/cli.mjs';
import { fetchSuite, SUITE_URL } from '../lib/ceb/fetch.mjs';
import { openManifest } from '../lib/ceb/manifest.mjs';
import { priceList, priceOf, tokenCost } from '../lib/ceb/prices.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const RUN = here('../run.mjs');
const FIXTURE = here('./fixtures/ceb/CEB-2026.12/manifest.json');
const SUITE = 'CEB-2026.12';
const list = priceList(SUITE);
const basis = BASIS[SUITE];
const opened = openManifest(readFileSync(FIXTURE), readFileSync(`${FIXTURE}.sig`, 'utf8'));
const manifest = opened.manifest;
const good = { model: 'claude-opus-5-5', effort: 'high', cap: '20 USD', mode: 'practice' };
const take = (o, harness = 'claude-code', prices = list) => intake(o, { manifest, list: prices, harness });
const refused = (o, pattern, harness, prices) => assert.throws(() => take(o, harness, prices), pattern);

test('the published suite verifies with the key the skill ships, and has twelve tasks', () => {
  assert.equal(manifest.suite, SUITE);
  assert.equal(manifest.tasks.length, 12);
  assert.equal(opened.keyId, '798c38a65d5837ad');
});

test('an alias is refused as a model id', () => {
  for (const alias of ['latest', 'opus', 'sonnet', 'claude-3-5-sonnet-latest', 'opus[1m]', 'gpt', 'default']) {
    assert.equal(isAlias(alias), true, alias);
    refused({ ...good, model: alias }, /is an alias/);
  }
  for (const exact of ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-haiku-5-5', 'gemini-4-carbon', 'grok-4.20-0309-reasoning']) assert.equal(isAlias(exact), false, exact);
  assert.equal(priceOf(list, 'grok-4.7'), null, 'a bare xAI name is an alias for the latest release, so it is not priced');
});

test('a model the suite does not price is refused, and a missing model says what to give', () => {
  refused({ ...good, model: 'claude-opus-9-9' }, /has no pinned price in suite CEB-2026\.12/);
  refused({ ...good, model: undefined }, /a model is required/);
  refused({ ...good, model: true }, /a model is required/);
});

test('a missing cap is refused, and so is one in another currency, at zero or malformed', () => {
  refused({ ...good, cap: undefined }, /a spending cap is required/);
  refused({ ...good, cap: true }, /a spending cap is required/);
  refused({ ...good, cap: '20 EUR' }, /must be in USD/);
  refused({ ...good, cap: '0 USD' }, /more than 0/);
  refused({ ...good, cap: 'twenty' }, /an amount and a currency/);
  assert.deepEqual(capOf('20 USD'), { amount: 20, currency: 'USD' });
  assert.deepEqual(capOf('usd 7.5'), { amount: 7.5, currency: 'USD' });
});

test('the estimate for a known configuration matches the figure worked out by hand from the price list', () => {
  // claude-opus-5-5: 4 USD input, 0.20 cached input, 20 output per million tokens.
  // A 30-minute task, 2 rounds, 6,000 input + 60,000 cached + 1,000 output tokens a minute and round:
  //   input 360,000 → 1.44; cached 3,600,000 → 0.72; output 60,000 → 1.20; together 3.36. Four rounds: 6.72.
  const one = estimate([{ id: 't', humanMinutes: 30 }], priceOf(list, 'claude-opus-5-5'), basis);
  assert.equal(one.expected, 3.36);
  assert.equal(one.high, 6.72);
  assert.deepEqual(one.tokens, { input: 360_000, cachedInput: 3_600_000, output: 60_000 });
  assert.equal(one.measured, false);
  // The whole suite is 585 human minutes: 585 / 30 × 3.36 = 65.52, and twice that at the round cap.
  assert.equal(manifest.tasks.reduce((n, t) => n + t.humanMinutes, 0), 585);
  const all = estimate(manifest.tasks, priceOf(list, 'claude-opus-5-5'), basis);
  assert.equal(all.expected, 65.52);
  assert.equal(all.high, 131.04);
  assert.equal(all.perTask.length, 12);
  // gpt-6.1-sol: 2 input, 0.10 cached, 10 output. A 45-minute task: 1.08 + 0.54 + 0.90 = 2.52.
  assert.equal(estimate([{ id: 't', humanMinutes: 45 }], priceOf(list, 'gpt-6.1-sol'), basis).expected, 2.52);
});

test('a baseline run is the model on its own: one session at its share of a round, and the arm is recorded', () => {
  // 60% of one round of a 30-minute task on claude-opus-5-5: input 108,000 → 0.432; cached 1,080,000 → 0.216;
  // output 18,000 → 0.36; together 1.008, shown as 1.01. There is no second round, so the high figure is the same.
  const est = estimate([{ id: 't', humanMinutes: 30 }], priceOf(list, 'claude-opus-5-5'), basisFor(basis, 'baseline'));
  assert.equal(est.expected, 1.01);
  assert.equal(est.high, 1.01);
  assert.equal(est.rounds, 1);
  assert.deepEqual(est.tokens, { input: 108_000, cachedInput: 1_080_000, output: 18_000 });
  assert.equal(basisFor(basis, 'coordinator'), basis);
  assert.equal(take(good).config.arm, 'coordinator');
  assert.equal(take({ ...good, arm: 'baseline' }).config.arm, 'baseline');
  refused({ ...good, arm: 'solo' }, /--arm must be coordinator/);
});

test('tokens are costed at the pinned prices; a cache write costs its own price, or the input price where there is none', () => {
  assert.equal(tokenCost(priceOf(list, 'claude-fable-5-2'), { input: 1e6, cachedInput: 1e6, cacheWrite: 1e6, output: 1e6 }), 58.2);
  assert.equal(tokenCost(priceOf(list, 'gpt-6-sol'), { cacheWrite: 1e6 }), 2);
  assert.equal(tokenCost(priceOf(list, 'claude-sonnet-5-5'), {}), 0);
  assert.throws(() => tokenCost(priceOf(list, 'claude-sonnet-5-5'), { input: -1 }), /0 or more/);
  assert.throws(() => priceList('CEB-1999.01'), /no pinned price list/);
});

test('every price is a number of dollars per million tokens, and a cache read never costs more than fresh input', () => {
  for (const [id, p] of Object.entries(list.models)) {
    for (const k of ['input', 'cachedInput', 'output']) assert.ok(Number.isFinite(p[k]) && p[k] > 0, `${id}.${k}`);
    assert.ok(p.cachedInput <= p.input, id);
    assert.equal(isAlias(id), false, id);
  }
});

test('the effort must be one the harness has, and the harness one the bench runs in', () => {
  assert.equal(take({ ...good, effort: 'max' }).config.effort, 'max');
  refused({ ...good, effort: 'max' }, /--effort must be one of minimal, low/, 'codex');
  refused({ ...good, effort: 'minimal' }, /--effort must be one of low, medium/);
  refused({ ...good, effort: undefined }, /an effort level is required/);
  refused(good, /runs in Claude Code or Codex/, 'gemini');
  assert.deepEqual(Object.keys(EFFORTS), ['claude-code', 'codex']);
});

test('a ranked run needs consent and takes no task list; a practice run may name its tasks', () => {
  refused({ ...good, mode: 'ranked' }, /needs --consent yes/);
  refused({ ...good, mode: 'ranked', consent: 'no' }, /needs --consent yes/);
  refused({ ...good, mode: 'ranked', consent: 'yes', task: 'invoice-idor' }, /the service picks the tasks/);
  refused({ ...good, mode: undefined }, /--mode practice/);
  refused({ ...good, consent: 'maybe' }, /--consent must be yes or no/);
  const ranked = take({ ...good, mode: 'ranked', consent: 'yes' });
  assert.equal(ranked.config.consent, true);
  assert.equal(ranked.tasks.length, 12);
  const two = take({ ...good, task: ['version-ranges,invoice-idor'] });
  assert.deepEqual(two.tasks.map((t) => t.id), ['invoice-idor', 'version-ranges'], 'in manifest order');
  assert.equal(two.config.consent, null);
  assert.match(two.tasks[0].image, /@sha256:[0-9a-f]{64}$/);
  refused({ ...good, task: 'no-such-task' }, /not a task of CEB-2026\.12: no-such-task/);
});

test('a model in a tool its maker does not document for it is allowed, and said', () => {
  const note = (model, harness) => routeNote({ harness }, priceOf(list, model));
  assert.equal(note('claude-opus-5-5', 'claude-code'), null);
  assert.equal(note('gpt-6.1-sol', 'codex'), null);
  assert.equal(note('glm-5.3', 'codex'), null);
  assert.match(note('gemini-4-carbon', 'claude-code'), /documented for Claude models only/);
  assert.match(note('claude-opus-5-5', 'codex'), /translating proxy/);
});

test('every problem is reported at once', () => {
  assert.throws(() => take({ model: 'latest' }, 'cursor'), (e) => {
    for (const part of [/is an alias/, /Claude Code or Codex/, /effort level is required/, /spending cap is required/, /--mode practice/]) assert.match(e.message, part);
    return true;
  });
});

test('an open-weight model must say how it is served; other models default to the vendor API', () => {
  const prices = { ...list, models: { ...list.models, 'open-model-1': { vendor: 'Example', openWeights: 'example/open-model-1', input: 1, cachedInput: 0.1, output: 2 } } };
  refused({ ...good, model: 'open-model-1' }, /is an open-weight model/, 'codex', prices);
  refused({ ...good, model: 'open-model-1', effort: 'high', serving: 'Has Spaces' }, /--serving must be a short name/, 'codex', prices);
  assert.equal(take({ ...good, model: 'open-model-1', serving: 'ollama-q4_k_m' }, 'codex', prices).config.serving, 'ollama-q4_k_m');
  assert.equal(take(good).config.serving, 'vendor-api');
  // The suite's own open-weight entries name their weights, and ask the same question.
  const open = Object.entries(list.models).filter(([, p]) => p.openWeights);
  assert.ok(open.length >= 5);
  for (const [id, p] of open) {
    assert.match(p.openWeights, /^[\w.-]+\/[\w.-]+$/, id);
    refused({ ...good, model: id, effort: 'high' }, /is an open-weight model/, 'codex');
  }
  assert.equal(take({ ...good, model: 'qwen3.8-27b', effort: 'high', serving: 'ollama-q4_k_m' }, 'codex').config.model, 'qwen3.8-27b');
});

test('nothing may start until the person has confirmed the estimate, and a ranked run not yet at all', () => {
  const now = new Date('2026-11-13T08:15:30Z');
  const { config, tasks, price } = take({ ...good, task: 'refund-crosses-month' });
  const record = planOf({ id: benchId(now), now, opened, config, tasks, est: estimate(tasks, price, basis) });
  assert.equal(record.id, 'bench-20261113-081530');
  assert.equal(record.status, 'planned');
  assert.equal(record.manifest.sha256, opened.sha256);
  assert.match(startRefusal(record), /has not confirmed the estimate/);
  assert.throws(() => confirmPlan(record, '  ', now), /go-ahead is required/);
  const confirmed = confirmPlan(record, 'yes, run it', now);
  assert.equal(startRefusal(confirmed), null);
  assert.deepEqual(confirmed.confirmed, { at: '2026-11-13T08:15:30.000Z', words: 'yes, run it' });
  assert.throws(() => confirmPlan(confirmed, 'again', now), /already confirmed/);
  assert.match(startRefusal({ ...confirmed, confirmed: null }), /has not confirmed/);
  const ranked = take({ ...good, mode: 'ranked', consent: 'yes' });
  const rankedPlan = confirmPlan(planOf({ id: 'b2', now, opened, config: ranked.config, tasks: ranked.tasks, est: estimate(ranked.tasks, ranked.price, basis) }), 'go', now);
  assert.match(startRefusal(rankedPlan), /needs a ticket from the benchmark service/);
  assert.equal(benchId(now, (id) => id === 'bench-20261113-081530'), 'bench-20261113-081530-2');
});

test('the manifest and its signature come from one fixed https place, with no redirect and a size limit', async () => {
  const calls = [];
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode(body).buffer });
  const stub = (bodies) => async (url, init) => { calls.push({ url, init }); return bodies[url.endsWith('.sig') ? 'sig' : 'manifest']; };
  const got = await fetchSuite(SUITE, { fetch: stub({ manifest: reply('{"a":1}'), sig: reply('{"s":1}') }) });
  assert.equal(got.manifest.toString(), '{"a":1}');
  assert.equal(got.signature, '{"s":1}');
  assert.deepEqual(calls.map((c) => c.url), [`${SUITE_URL}/CEB-2026.12/manifest.json`, `${SUITE_URL}/CEB-2026.12/manifest.json.sig`]);
  assert.ok(SUITE_URL.startsWith('https://raw.githubusercontent.com/mindmakr/coordinator-bench/'));
  for (const c of calls) { assert.equal(c.init.redirect, 'error'); assert.equal(c.init.credentials, 'omit'); }
  await assert.rejects(fetchSuite(SUITE, { fetch: stub({ manifest: reply('gone', 404) }) }), /HTTP 404/);
  await assert.rejects(fetchSuite(SUITE, { fetch: stub({ manifest: reply('{}'), sig: reply('x'.repeat(5000)) }) }), /larger than 4096 bytes/);
  await assert.rejects(fetchSuite(SUITE, { fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }), /could not fetch .*Offline\? Pass --manifest/);
  await assert.rejects(fetchSuite('../../etc', { fetch: stub({}) }), /--suite must look like/);
});

test('planning starts no process: only the runner does, and it refuses a plan that is not confirmed (ceb-run.test.mjs)', () => {
  for (const f of ['bench.mjs', 'cli.mjs', 'prices.mjs', 'fetch.mjs', 'trial.mjs']) {
    assert.doesNotMatch(readFileSync(here(`../lib/ceb/${f}`), 'utf8'), /child_process|\bspawn\b|\bexecFile/, f);
  }
});

const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', env: { ...process.env, COORDINATOR_DIR: dir } });
  return { status: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
};

test('run.mjs bench --help lists every option', () => {
  const r = cli(mkdtempSync(join(tmpdir(), 'ceb-bench-')), 'bench', '--help');
  assert.equal(r.status, 0);
  for (const flag of [...BENCH_FLAGS, 'harness']) assert.match(r.out, new RegExp(`--${flag}\\b`), flag);
  for (const verb of ['bench plan', 'bench confirm', 'bench show', 'bench prices']) assert.ok(r.out.includes(verb), verb);
});

test('run.mjs bench: plan from a manifest on disk, show the estimate, confirm, and only then may it start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceb-bench-'));
  const base = ['--manifest', FIXTURE, '--harness', 'claude-code'];
  const noCap = cli(dir, 'bench', 'plan', '--model', 'claude-opus-5-5', '--effort', 'high', '--mode', 'practice', ...base);
  assert.equal(noCap.status, 1);
  assert.match(noCap.err, /a spending cap is required/);
  assert.deepEqual(cli(dir, 'bench', 'show').json(), { plans: [] }, 'a refused plan stores nothing');

  const planned = cli(dir, 'bench', 'plan', '--model', 'claude-opus-5-5', '--effort', 'high', '--cap', '2 USD', '--mode', 'practice', '--task', 'refund-crosses-month', ...base);
  assert.equal(planned.status, 0, planned.err);
  const plan = planned.json();
  assert.equal(plan.status, 'planned');
  assert.equal(plan.estimate.expected, 3.36);
  assert.equal(plan.plannedBy.harness, 'claude-code');
  assert.match(plan.say.join(' '), /About 3\.36 USD for 1 task/);
  assert.match(plan.say.join(' '), /not a measurement/);
  assert.match(plan.say.join(' '), /above your cap/);
  const stored = JSON.parse(readFileSync(join(dir, 'bench', plan.id, 'bench.json'), 'utf8'));
  assert.equal(stored.say, undefined, 'only the record is stored');
  assert.equal(stored.config.cap.amount, 2);

  const before = cli(dir, 'bench', 'show', plan.id).json();
  assert.equal(before.mayStart, false);
  assert.equal(cli(dir, 'bench', 'confirm', plan.id).status, 1, 'no words, no confirmation');
  const after = cli(dir, 'bench', 'confirm', plan.id, '--confirm', 'yes, go ahead').json();
  assert.equal(after.status, 'confirmed');
  assert.equal(after.mayStart, true);
  assert.equal(cli(dir, 'bench', 'confirm', plan.id, '--confirm', 'again').status, 1);
  assert.deepEqual(cli(dir, 'bench', 'show').json().plans.map((p) => [p.id, p.status, p.estimate]), [[plan.id, 'confirmed', '3.36 USD']]);
  assert.equal(cli(dir, 'bench', 'show', 'no-such-plan').status, 1);
});

test('run.mjs bench plan refuses a manifest whose bytes changed, and prints the price list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceb-bench-'));
  const tampered = join(dir, 'manifest.json');
  writeFileSync(tampered, readFileSync(FIXTURE, 'utf8').replace('"humanMinutes": 30', '"humanMinutes": 31'));
  const r = cli(dir, 'bench', 'plan', '--model', 'claude-opus-5-5', '--effort', 'high', '--cap', '20 USD', '--mode', 'practice', '--manifest', tampered, '--sig', `${FIXTURE}.sig`, '--harness', 'codex');
  assert.equal(r.status, 1);
  assert.match(r.err, /signature/i);
  const prices = cli(dir, 'bench', 'prices').json();
  assert.equal(prices.currency, 'USD');
  assert.equal(prices.models['claude-opus-5-5'].output, 20);
  assert.equal(prices.estimateBasis.measured, false);
});
