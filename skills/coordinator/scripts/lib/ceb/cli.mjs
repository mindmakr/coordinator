// run.mjs bench: plan a run of the Coordinator Engineering Benchmark, show what it should
// cost, and record the person's go-ahead (references/commands/bench.md, references/ceb-bench.md).
// No model is called by these commands, and none may be until the estimate is confirmed.
//
//   run.mjs bench plan --model <exact model id> --effort <level> --cap "20 USD" --mode practice|ranked
//                  checks the configuration, fetches and verifies the suite's signed manifest, and
//                  stores a plan with a cost estimate at the suite's pinned prices. Options:
//                  --model     the exact id the provider serves, never an alias such as "latest" or "opus";
//                              it must have a pinned price (bench prices)
//                  --effort    claude-code: low|medium|high|xhigh|max   codex: minimal|low|medium|high|xhigh
//                  --cap       the most the run may spend at pinned prices, e.g. "20 USD"; required
//                  --mode      practice (never reaches the board) or ranked (needs the service; not started yet)
//                  --arm       coordinator (default: through the Coordinator loop) or baseline (the same model on
//                              its own in the same tool), so the board can show what the loop adds
//                  --consent   yes|no: publish the result under the person's GitHub handle; ranked needs yes
//                  --task      practice only: the task ids to run (a,b or repeated); default every task
//                  --serving   how the model is served, e.g. vendor-api (default), openrouter, ollama-q4_k_m;
//                              required for an open-weight model
//                  --suite     default CEB-2026.12
//                  --manifest <file> [--sig <file>]   read the manifest from disk instead of the network
//                  --harness   claude-code|codex: the tool that runs the tasks; else the one this ran in
//   run.mjs bench confirm <id> --confirm "their words"   the person agreed to the estimate of that plan
//   run.mjs bench show [<id>]      one plan with whether it may start, or every plan here
//   run.mjs bench prices [--suite S]   the suite's pinned price list and the basis of the estimate
//
// Plans are kept in <state folder>/bench/<id>/bench.json. `bench plan` is the only one that calls the
// network: two GETs for the manifest and its signature (lib/ceb/fetch.mjs), unless --manifest is given.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headerText, text } from '../args.mjs';
import { isSafeId, readJson, safeId, update, writeJson } from '../store.mjs';
import { BASIS, basisFor, benchId, confirmPlan, estimate, estimateText, intake, planOf, routeNote, startRefusal } from './bench.mjs';
import { fetchSuite, suiteId } from './fetch.mjs';
import { openManifest } from './manifest.mjs';
import { priceList } from './prices.mjs';

export const DEFAULT_SUITE = 'CEB-2026.12';
export const BENCH_FLAGS = ['model', 'effort', 'cap', 'mode', 'arm', 'consent', 'task', 'serving', 'suite', 'manifest', 'sig', 'confirm'];
export const BENCH_REPEAT = ['task'];
export const benchHelp = () => headerText(import.meta.url);

const dir = (base) => join(base, 'bench');
const file = (base, id) => join(dir(base), safeId(id, 'bench id'), 'bench.json');
const str = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`--${name} needs a value`); return v; };

function load(base, id) {
  if (!id) throw new Error('which plan? run.mjs bench show lists them');
  const f = file(base, id);
  if (!existsSync(f)) throw new Error(`no bench plan ${id} here (run.mjs bench show lists them)`);
  return readJson(f, null);
}

async function manifestBytes(o, suite, fetchFn) {
  if (o.manifest === undefined) {
    if (o.sig !== undefined) throw new Error('--sig goes with --manifest');
    return fetchSuite(suite, fetchFn ? { fetch: fetchFn } : {});
  }
  const path = str(o.manifest, 'manifest');
  const sig = o.sig === undefined ? `${path}.sig` : str(o.sig, 'sig');
  for (const p of [path, sig]) if (!existsSync(p)) throw new Error(`no such file: ${p}`);
  return { manifest: readFileSync(path), signature: readFileSync(sig, 'utf8') };
}

async function plan(o, { base, by, now, fetch }) {
  const suite = suiteId(o.suite === undefined ? DEFAULT_SUITE : o.suite);
  const list = priceList(suite);
  const basis = BASIS[suite];
  if (!basis) throw new Error(`no estimate basis for suite ${suite} in this copy of the coordinator`);
  const { manifest, signature } = await manifestBytes(o, suite, fetch);
  const opened = openManifest(manifest, signature);
  if (opened.manifest.suite !== suite) throw new Error(`the manifest is for ${opened.manifest.suite}, not ${suite}`);
  const { config, tasks, price } = intake(o, { manifest: opened.manifest, list, harness: by?.harness });
  const est = estimate(tasks, price, basisFor(basis, config.arm), { currency: list.currency, per: list.per });
  const id = benchId(now, (candidate) => existsSync(join(dir(base), candidate)));
  const record = planOf({ id, now, opened, config, tasks, est, by });
  writeJson(file(base, id), record);
  return {
    ...record,
    say: [...estimateText(est, config.cap, config.arm), ...(price.note ? [`${config.model}: ${price.note}.`] : []), ...(routeNote(config, price) ? [routeNote(config, price)] : [])],
    next: `show the person the estimate; when they agree: run.mjs bench confirm ${id} --confirm "<their words>"`,
  };
}

function confirm([, id], o, { base, now }) {
  load(base, id);
  const words = text(o.confirm === true ? undefined : o.confirm, 'confirm', 500);
  const record = update(file(base, id), null, (r) => confirmPlan(r, words, now));
  return { ...record, mayStart: startRefusal(record) === null, ...(startRefusal(record) ? { refusal: startRefusal(record) } : {}) };
}

function show([, id], { base }) {
  if (id) { const r = load(base, id); const refusal = startRefusal(r); return { ...r, mayStart: refusal === null, ...(refusal ? { refusal } : {}) }; }
  const ids = existsSync(dir(base)) ? readdirSync(dir(base)).filter((n) => isSafeId(n) && existsSync(file(base, n))).sort() : [];
  return { plans: ids.map((n) => { const r = readJson(file(base, n), null); return { id: n, suite: r.suite, model: r.config.model, harness: r.config.harness, arm: r.config.arm, mode: r.config.mode, tasks: r.tasks.length, estimate: `${r.estimate.expected} ${r.estimate.currency}`, status: r.status }; }) };
}

function prices(o) {
  const suite = suiteId(o.suite === undefined ? DEFAULT_SUITE : o.suite);
  const list = priceList(suite);
  return { suite, currency: list.currency, perTokens: list.per, checked: list.checked, sources: list.sources, models: list.models, estimateBasis: BASIS[suite] ?? null };
}

// One bench command. `by` is the stamp of the tool that ran it ({ harness, skill }); `fetch` can be replaced in tests.
export async function benchCommand(pos, o, { base, by = null, now = new Date(), fetch = null } = {}) {
  switch (pos[0]) {
    case 'plan': return plan(o, { base, by, now, fetch });
    case 'confirm': return confirm(pos, o, { base, now });
    case 'show': return show(pos, { base });
    case 'prices': return prices(o);
    default: throw new Error('usage: run.mjs bench plan|confirm|show|prices … (run.mjs bench --help)');
  }
}
