// Helper models: small, cheap models for small jobs (a pick-one decision, a
// one-line summary of an agent's steps, a first look at a screenshot), so the
// strong model is not paid to do them. Off unless `.coordinator/coordinator.json`
// has `"helpers"`; everything works without it. See references/helpers.md.
//
//   "helpers": { "provider": "ollama" | "lmstudio" | "openrouter" | "openai" | "custom",
//                "endpoint": "<OpenAI-compatible base URL>",   (the provider's by default)
//                "keyEnv": "OPENROUTER_API_KEY",               (the NAME of an env variable, never the key)
//                "models": { "decide": "...", "summarize": "...", "look": "..." },
//                "minConfidence": 0.8 }
//
// Pure: building requests and reading answers. The one network call is in
// helpercall.mjs.
import { maskSecrets } from './secrets.mjs';

export const JOBS = ['decide', 'summarize', 'look'];
export const PROVIDERS = {
  ollama: { endpoint: 'http://127.0.0.1:11434/v1', models: { decide: 'gemma3:4b', summarize: 'gemma3:1b', look: 'qwen2.5vl:7b' } },
  lmstudio: { endpoint: 'http://127.0.0.1:1234/v1', models: { decide: 'google/gemma-3-4b', summarize: 'google/gemma-3-1b', look: 'qwen/qwen2.5-vl-7b' } },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: { decide: 'google/gemini-2.5-flash-lite', summarize: 'google/gemini-2.5-flash-lite', look: 'google/gemini-2.5-flash-lite' } },
  openai: { endpoint: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: { decide: 'gpt-4.1-nano', summarize: 'gpt-4.1-nano', look: 'gpt-4.1-mini' } },
  custom: { models: {} },
};
export const DEFAULT_MIN_CONFIDENCE = 0.8;
// What a first look at a screen checks when no question is given (references/helpers.md).
export const LOOK_CHECKS = ['blank or half-loaded screen', 'error message, popup or crash screen', 'text cut off, overlapping or overflowing its box',
  'raw translation keys or placeholders (like home.title or {name})', 'text in the wrong language for the screen', 'layout mirrored wrongly for the text direction',
  'broken image or missing icon', 'element drawn off screen or hidden behind another'];

const KEYS = ['provider', 'endpoint', 'keyEnv', 'models', 'minConfidence'];
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MODEL = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Loopback, or a private network address (another PC at home or in your cloud network).
export function hostKind(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)) return 'loopback';
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.ts.net')) return 'private';
  return 'public';
}

// null, or why this endpoint is refused: https unless loopback or private, never a user or password in it.
export function endpointProblem(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return 'endpoint is not a URL'; }
  if (url.username || url.password) return 'endpoint must not carry a user or password (put the key in an environment variable and name it in keyEnv)';
  if (url.search || url.hash) return 'endpoint must not carry a query or fragment';
  const kind = hostKind(url.hostname);
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && kind !== 'public') return null;
  return 'endpoint must be https (http only on this machine or a private network)';
}

// Problems with the `helpers` settings: [{ level: 'fail'|'warn', text }].
export function checkHelpers(h) {
  const out = [];
  const bad = (text, level = 'fail') => out.push({ level, text });
  if (h === false) return out;
  if (!isObj(h)) return [{ level: 'fail', text: 'helpers must be false or an object { provider, endpoint, keyEnv, models, minConfidence }' }];
  for (const k of Object.keys(h)) {
    if (/key|token|secret|password|auth/i.test(k) && k !== 'keyEnv') bad(`helpers.${k}: never store a key here; put it in an environment variable and name it in keyEnv`);
    else if (!KEYS.includes(k)) bad(`helpers: unknown key "${k}" (known: ${KEYS.join(', ')})`, 'warn');
  }
  if (h.provider !== undefined && !Object.hasOwn(PROVIDERS, h.provider)) bad(`helpers.provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
  const endpoint = h.endpoint ?? PROVIDERS[h.provider]?.endpoint;
  if (endpoint === undefined) bad('helpers.endpoint is required for a custom provider');
  else if (typeof endpoint !== 'string') bad('helpers.endpoint must be a string');
  else { const p = endpointProblem(endpoint); if (p) bad(`helpers.${p}`); else if (new URL(endpoint).protocol === 'http:' && hostKind(new URL(endpoint).hostname) === 'private') bad('helpers.endpoint is plain http on a private network: prompts and screenshots cross it unencrypted', 'warn'); }
  if (h.keyEnv !== undefined && (typeof h.keyEnv !== 'string' || !ENV_NAME.test(h.keyEnv))) bad('helpers.keyEnv must be the NAME of an environment variable (like OPENROUTER_API_KEY), never the key itself');
  if (h.models !== undefined) {
    if (!isObj(h.models)) bad('helpers.models must be an object { decide, summarize, look }');
    else for (const [job, m] of Object.entries(h.models)) {
      if (!JOBS.includes(job)) bad(`helpers.models: unknown job "${job}" (known: ${JOBS.join(', ')})`, 'warn');
      else if (m !== false && (typeof m !== 'string' || !MODEL.test(m))) bad(`helpers.models.${job} must be a model name or false`);
    }
  }
  if (h.minConfidence !== undefined && !(typeof h.minConfidence === 'number' && h.minConfidence >= 0.5 && h.minConfidence <= 1)) bad('helpers.minConfidence must be a number from 0.5 to 1');
  return out;
}

// The settings resolved over the provider's defaults: { on, provider, endpoint, keyEnv, models, minConfidence, local, host }.
// on is false when helpers are absent, false, or broken (problems lists why).
export function helperConfig(settings) {
  const h = settings?.helpers;
  if (h === undefined || h === false) return { on: false, why: 'no helpers set (references/helpers.md)' };
  const problems = checkHelpers(h).filter((p) => p.level === 'fail');
  if (problems.length) return { on: false, why: problems.map((p) => p.text).join('; ') };
  const preset = PROVIDERS[h.provider ?? 'custom'];
  const endpoint = (h.endpoint ?? preset.endpoint).replace(/\/+$/, '');
  const host = new URL(endpoint).hostname;
  return {
    on: true, provider: h.provider ?? 'custom', endpoint, host, local: hostKind(host) !== 'public',
    keyEnv: h.keyEnv ?? preset.keyEnv ?? null,
    models: { ...preset.models, ...(isObj(h.models) ? h.models : {}) },
    minConfidence: h.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  };
}

// The `helpers` object `helper.mjs setup` writes: the provider and only what differs from its defaults.
export function setupHelpers(provider, { endpoint, keyEnv, models = {}, minConfidence } = {}) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(`provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
  const h = { provider };
  if (endpoint !== undefined) h.endpoint = endpoint;
  if (keyEnv !== undefined) h.keyEnv = keyEnv;
  const own = Object.fromEntries(Object.entries(models).filter(([job, m]) => m !== undefined && PROVIDERS[provider].models[job] !== m));
  if (Object.keys(own).length) h.models = own;
  if (minConfidence !== undefined) h.minConfidence = minConfidence;
  if (provider === 'custom' && !h.endpoint) throw new Error('a custom provider needs --endpoint');
  const fails = checkHelpers(h).filter((p) => p.level === 'fail');
  if (fails.length) throw new Error(fails.map((p) => p.text).join('; '));
  return h;
}

const clean = (s, max) => maskSecrets(String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')).slice(0, max);
const schema = (name, properties, required) => ({ type: 'json_schema', json_schema: { name, strict: true, schema: { type: 'object', properties, required, additionalProperties: false } } });

// The chat request for one job. Text is masked for secrets before it leaves; the caller adds the key.
//   decide:    { question, choices: [..2-20], context? }          → { answer: one of choices, confidence }
//   summarize: { text, maxWords? }                                 → { summary }
//   look:      { image: { mime, base64 }, question?, context? }    → { problems: [..], confidence }
export function buildRequest(job, cfg, input) {
  if (!JOBS.includes(job)) throw new Error(`job must be one of: ${JOBS.join(', ')}`);
  const model = cfg.models?.[job];
  if (!model) throw new Error(`no helper model set for ${job} (helpers.models.${job})`);
  let messages; let format;
  if (job === 'decide') {
    const choices = (input.choices ?? []).map((c) => clean(c, 200).trim()).filter(Boolean);
    if (choices.length < 2 || choices.length > 20 || new Set(choices).size !== choices.length) throw new Error('decide needs 2-20 different choices');
    if (!String(input.question ?? '').trim()) throw new Error('decide needs a question');
    messages = [
      { role: 'system', content: 'You answer one question by picking exactly one of the given choices. Reply with JSON only. confidence is your probability (0 to 1) that the choice is right; use a low number when the context does not settle it.' },
      { role: 'user', content: `${input.context ? `Context:\n${clean(input.context, 24_000)}\n\n` : ''}Question: ${clean(input.question, 1000)}\nChoices: ${JSON.stringify(choices)}` },
    ];
    format = schema('decision', { answer: { type: 'string', enum: choices }, confidence: { type: 'number' } }, ['answer', 'confidence']);
  } else if (job === 'summarize') {
    const words = Math.min(Math.max(Number(input.maxWords) || 25, 5), 120);
    if (!String(input.text ?? '').trim()) throw new Error('summarize needs text');
    messages = [
      { role: 'system', content: `You summarize what a software agent did, from its tool calls and output, in plain words a person reads at a glance: at most ${words} words, past tense, name files and commands, no filler. Reply with JSON only.` },
      { role: 'user', content: clean(input.text, 32_000) },
    ];
    format = schema('summary', { summary: { type: 'string' } }, ['summary']);
  } else {
    const img = input.image;
    if (!img || !/^image\/(png|jpeg|webp|gif)$/.test(img.mime) || typeof img.base64 !== 'string' || !img.base64) throw new Error('look needs a png, jpeg, webp or gif image');
    const ask = input.question ? clean(input.question, 1000) : `List every problem of these kinds you can see: ${LOOK_CHECKS.join('; ')}.`;
    messages = [
      { role: 'system', content: 'You check one screenshot of an app for visible defects. Report only what you can see; never guess about things outside the image. Each problem: what it is and where on the screen. An empty list means you saw none. confidence is your probability (0 to 1) that your list is complete and right. Reply with JSON only.' },
      { role: 'user', content: [{ type: 'text', text: `${input.context ? `Screen: ${clean(input.context, 2000)}\n` : ''}${ask}` }, { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } }] },
    ];
    format = schema('look', { problems: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } }, ['problems', 'confidence']);
  }
  return { url: `${cfg.endpoint}/chat/completions`, body: { model, messages, temperature: 0, max_tokens: job === 'summarize' ? 300 : 600, stream: false, response_format: format } };
}

// The first JSON object in a model's reply (some local servers wrap it in prose or a code fence).
function firstObject(text) {
  const s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  for (let end = s.lastIndexOf('}'); start >= 0 && end > start; end = s.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* shorter */ }
  }
  return null;
}
const conf = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v > 1 && v <= 100 ? v / 100 : v, 0), 1) : null);

// The answer from a chat completion. escalate: true means "hand this to the strong model": the reply did not
// parse, picked something not offered, or its confidence is below minConfidence. A helper never guesses past that.
export function readAnswer(job, cfg, input, response) {
  const content = response?.choices?.[0]?.message?.content;
  const usage = response?.usage ? { tokensIn: response.usage.prompt_tokens ?? null, tokensOut: response.usage.completion_tokens ?? null } : null;
  const base = { job, model: response?.model ?? cfg.models?.[job] ?? null, provider: cfg.provider, local: cfg.local, ...(usage ? { usage } : {}) };
  const o = firstObject(typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '');
  if (!o || typeof o !== 'object') return { ...base, escalate: true, why: 'the helper reply was not JSON' };
  if (job === 'summarize') {
    const summary = clean(o.summary, 600).trim();
    return summary ? { ...base, summary, escalate: false } : { ...base, escalate: true, why: 'the helper gave no summary' };
  }
  const confidence = conf(o.confidence);
  const low = confidence === null || confidence < cfg.minConfidence;
  if (job === 'decide') {
    const choices = (input.choices ?? []).map((c) => clean(c, 200).trim());
    const answer = typeof o.answer === 'string' ? choices.find((c) => c === o.answer.trim()) ?? choices.find((c) => c.toLowerCase() === o.answer.trim().toLowerCase()) : undefined;
    if (answer === undefined) return { ...base, escalate: true, why: `the helper picked something not offered: ${clean(o.answer, 80)}` };
    return { ...base, answer, confidence, escalate: low, ...(low ? { why: `confidence ${confidence ?? 'missing'} is below ${cfg.minConfidence}` } : {}) };
  }
  const problems = Array.isArray(o.problems) ? o.problems.map((p) => clean(typeof p === 'string' ? p : JSON.stringify(p), 300).trim()).filter(Boolean).slice(0, 30) : null;
  if (!problems) return { ...base, escalate: true, why: 'the helper gave no problem list' };
  // A clean look never passes a screen: the visual critic still judges it (references/helpers.md).
  return { ...base, problems, flagged: problems.length > 0 || low, confidence, escalate: low, ...(low ? { why: `confidence ${confidence ?? 'missing'} is below ${cfg.minConfidence}` } : {}) };
}

// Model ids a server lists at GET /models, and which configured ones are missing from it.
export function missingModels(cfg, listing) {
  const have = new Set((Array.isArray(listing?.data) ? listing.data : Array.isArray(listing?.models) ? listing.models : []).map((m) => m?.id ?? m?.name ?? m?.model).filter(Boolean));
  const wanted = JOBS.map((j) => cfg.models?.[j]).filter(Boolean);
  // Ollama lists "gemma3:4b"; a configured "gemma3" means "gemma3:latest".
  const found = (m) => have.has(m) || have.has(`${m}:latest`);
  return { listed: have.size, missing: [...new Set(wanted.filter((m) => !found(m)))] };
}
