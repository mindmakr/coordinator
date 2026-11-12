#!/usr/bin/env node
// Helper models: small, cheap models (local or through a router) for small jobs,
// so the strong model is not paid for them. Off until `setup`; see references/helpers.md.
//
//   helper.mjs status                       the settings in use (no network)
//   helper.mjs setup <ollama|lmstudio|openrouter|openai|custom> [--endpoint URL] [--key-env NAME]
//                    [--decide M] [--summarize M] [--look M] [--min-confidence 0.8]
//                                           writes "helpers" in .coordinator/coordinator.json
//   helper.mjs setup off                    removes it
//   helper.mjs ping                         asks the server which models it has; names the missing ones
//   helper.mjs decide --question Q --choice A --choice B [...] [--context T | --context-file F]
//   helper.mjs summarize (--text T | --file F) [--max-words 25]
//   helper.mjs look --image shot.png [--question Q] [--context "screen, locale, width"]
//   helper.mjs stats                        calls, escalations, time and tokens per job in this project,
//                                           with advice when a job escalates too often to be worth it
//
// Every answer is JSON. escalate: true means "do not use this; ask the strong model": the reply did
// not parse, or its confidence is under minConfidence. A look never passes a screen on its own.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { helpAndExit, parse } from './lib/args.mjs';
import { buildRequest, helperConfig, missingModels, PROVIDERS, readAnswer, setupHelpers } from './lib/helpers.mjs';
import { complete, listModels } from './lib/helpercall.mjs';
import { readSettings, settingsFile, settingsTracked, TRACKED_FIX, trackedRefusal } from './lib/settings.mjs';
import { join } from 'node:path';
import { baseDir, readJson, update, withLock, writeAtomic } from './lib/store.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE = 8 * 1024 * 1024;
const FLAGS = ['endpoint', 'key-env', 'decide', 'summarize', 'look', 'min-confidence', 'question', 'choice', 'context', 'context-file', 'text', 'file', 'max-words', 'image'];

const readText = (f, what) => {
  if (typeof f !== 'string' || !existsSync(f) || !statSync(f).isFile()) throw new Error(`${what}: no file ${f}`);
  return readFileSync(f, 'utf8');
};
const str = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`missing --${name}`); return v; };

function config() {
  const base = baseDir('project');
  const { settings, error } = readSettings(base);
  if (error) throw new Error(`${settingsFile(base)}: ${error}`);
  // The helper endpoint is sent the key named in keyEnv, so a committed settings file may not turn helpers on.
  if (settings.helpers !== undefined && settings.helpers !== false && settingsTracked(base)) return { on: false, tracked: true, why: trackedRefusal('helpers') };
  return helperConfig(settings);
}
function needOn() {
  const cfg = config();
  if (!cfg.on) throw new Error(cfg.tracked ? `helpers are off: ${cfg.why}` : `helpers are off: ${cfg.why}. Set them up with: helper.mjs setup ollama (or lmstudio, openrouter, openai, custom)`);
  return cfg;
}
const shown = (cfg) => (cfg.on ? { on: true, provider: cfg.provider, endpoint: cfg.endpoint, local: cfg.local, keyEnv: cfg.keyEnv, keySet: cfg.keyEnv ? Boolean(process.env[cfg.keyEnv]) : null, models: cfg.models, minConfidence: cfg.minConfidence } : cfg);

function writeHelpers(value) {
  const base = baseDir('project'); const file = settingsFile(base);
  if (value !== undefined && settingsTracked(base)) throw new Error(`${file} is committed to git, so helpers set in it would be ignored; ${TRACKED_FIX}`);
  return withLock(file, () => {
    const { settings, error } = readSettings(base);
    if (error) throw new Error(`${file}: ${error}; fix it first`);
    if (value === undefined) delete settings.helpers; else settings.helpers = value;
    writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
    return file;
  });
}

// Counts per job, kept in the project's state folder: numbers only, never a prompt or an answer.
const usageFile = () => join(baseDir('project'), 'helpers-usage.json');
const OFTEN = { calls: 10, rate: 0.3 };
function record(job, out) {
  update(usageFile(), {}, (all) => {
    const j = (all[job] ??= { calls: 0, escalated: 0, ms: 0, tokensIn: 0, tokensOut: 0 });
    j.calls++; if (out.escalate) j.escalated++;
    j.ms += out.ms; j.tokensIn += out.usage?.tokensIn ?? 0; j.tokensOut += out.usage?.tokensOut ?? 0;
    j.lastAt = new Date().toISOString();
  });
}

async function ask(job, input) {
  const cfg = needOn();
  const req = buildRequest(job, cfg, input);
  const started = Date.now();
  const res = await complete(cfg, req);
  const out = { ...readAnswer(job, cfg, input, res), ms: Date.now() - started, ...(cfg.local ? {} : { sentTo: cfg.host }) };
  try { record(job, out); } catch { /* counting never fails a call */ }
  return out;
}

const commands = {
  status: () => shown(config()),
  stats() {
    const all = readJson(usageFile(), {});
    const jobs = Object.fromEntries(Object.entries(all).filter(([, j]) => j && typeof j === 'object' && j.calls > 0).map(([job, j]) => {
      const rate = Math.round((j.escalated / j.calls) * 100) / 100;
      const often = j.calls >= OFTEN.calls && rate >= OFTEN.rate;
      return [job, { ...j, escalationRate: rate, ...(often ? { advice: `${job} hands back ${Math.round(rate * 100)}% of its answers: give it a stronger model (helper.mjs setup <provider> --${job} <model>) or stop using it for this job` } : {}) }];
    }));
    return { jobs, calls: Object.values(jobs).reduce((n, j) => n + j.calls, 0) };
  },
  setup([provider], o) {
    if (provider === 'off') return { helpers: 'off', file: writeHelpers(undefined) };
    if (!provider) throw new Error(`setup needs a provider: ${Object.keys(PROVIDERS).join(', ')}, or off`);
    const minConfidence = o['min-confidence'] === undefined ? undefined : Number(o['min-confidence']);
    const h = setupHelpers(provider, { endpoint: o.endpoint, keyEnv: o['key-env'], models: { decide: o.decide, summarize: o.summarize, look: o.look }, minConfidence });
    const file = writeHelpers(h);
    const cfg = helperConfig({ helpers: h });
    const next = cfg.keyEnv && !process.env[cfg.keyEnv] ? `set ${cfg.keyEnv} in your environment, then run helper.mjs ping` : 'run helper.mjs ping to check the server and models';
    return { ...shown(cfg), file, next };
  },
  async ping() {
    const cfg = needOn();
    const { listed, missing } = missingModels(cfg, await listModels(cfg));
    const fix = missing.length ? (cfg.provider === 'ollama' ? missing.map((m) => `ollama pull ${m}`).join(' && ') : `load or name models the server has (helpers.models): ${missing.join(', ')}`) : null;
    return { ok: missing.length === 0, endpoint: cfg.endpoint, listed, missing, ...(fix ? { fix } : {}) };
  },
  decide: (_, o) => ask('decide', {
    question: str(o.question, 'question'), choices: o.choice ?? [],
    context: o['context-file'] !== undefined ? readText(o['context-file'], '--context-file') : o.context,
  }),
  summarize: (_, o) => ask('summarize', { text: o.file !== undefined ? readText(o.file, '--file') : str(o.text, 'text'), maxWords: o['max-words'] }),
  look(_, o) {
    const f = str(o.image, 'image');
    const mime = MIME[extname(f).toLowerCase()];
    if (!mime) throw new Error('--image must be a .png, .jpg, .webp or .gif file');
    if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`--image: no file ${f}`);
    if (statSync(f).size > MAX_IMAGE) throw new Error('--image is over 8 MB; crop or scale it first');
    return ask('look', { image: { mime, base64: readFileSync(f).toString('base64') }, question: o.question, context: o.context });
  },
};

helpAndExit(import.meta.url);
try {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(commands, cmd ?? '')) throw new Error(`usage: helper.mjs ${Object.keys(commands).join('|')} …`);
  const { pos, opt } = parse(argv, FLAGS, ['choice']);
  const out = await commands[cmd](pos, opt);
  console.log(JSON.stringify(out, null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
