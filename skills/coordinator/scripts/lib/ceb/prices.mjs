// The pinned price list of each CEB suite (references/ceb-bench.md): USD per
// million tokens, read from each provider's own pricing page on the date given.
// Cost on the board is tokens times these prices, so two runners with different
// discounts compare fairly (docs/design/ceb.md, 2.3). A suite never changes a
// price it has published; a model is added with a new entry. A model id here is
// the exact id the provider serves, never an alias that can move. Pure.

const NOTE_272K = 'priced at the rate for prompts up to 272,000 tokens; the provider charges more above that';
const NOTE_200K = 'priced at the rate for prompts under 200,000 tokens; the provider charges double at or above that';
const NOTE_PEAK = "the publisher's peak-hours price; its off-peak price is half";
const standardFrom =(date) => `the provider's standard price from ${date}; a lower introductory price applied before that`;

export const PRICES = {
  'CEB-2026.12': {
    currency: 'USD',
    per: 1_000_000,
    checked: '2026-11-13',
    sources: [
      'https://platform.claude.com/docs/en/about-claude/pricing',
      'https://developers.openai.com/api/docs/pricing',
      'https://aistudio.google.com/docs/pricing',
      'https://docs.x.ai/docs/models',
      'https://api-docs.deepseek.com/quick_start/pricing',
      'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
      'https://docs.z.ai/guides/overview/pricing',
      'https://platform.minimax.io/docs/guides/pricing-paygo',
      'https://docs.mistral.ai/models/mistral-large-4-0',
    ],
    models: {
      'claude-fable-5-2': { vendor: 'Anthropic', input: 8, cacheWrite: 10, cachedInput: 0.2, output: 40 },
      'claude-opus-5-5': { vendor: 'Anthropic', input: 4, cacheWrite: 5, cachedInput: 0.2, output: 20 },
      'claude-opus-5': { vendor: 'Anthropic', input: 5, cacheWrite: 6.25, cachedInput: 0.5, output: 25 },
      'claude-sonnet-5-5': { vendor: 'Anthropic', input: 2, cacheWrite: 2.5, cachedInput: 0.1, output: 10 },
      'claude-sonnet-5': { vendor: 'Anthropic', input: 2, cacheWrite: 2.5, cachedInput: 0.2, output: 10 },
      'claude-haiku-5-5': { vendor: 'Anthropic', input: 0.5, cacheWrite: 0.625, cachedInput: 0.05, output: 2.5, note: 'priced at the rate for prompts over 100,000 tokens, because token totals do not say how large each prompt was; shorter prompts cost a fifth of this at the provider' },
      'gpt-6-astra': { vendor: 'OpenAI', input: 10, cachedInput: 1, output: 50, note: NOTE_272K },
      'gpt-6.1-sol': { vendor: 'OpenAI', input: 2, cachedInput: 0.1, output: 10, note: NOTE_272K },
      'gpt-6.1-terra': { vendor: 'OpenAI', input: 1, cachedInput: 0.05, output: 5, note: NOTE_272K },
      'gpt-6-sol': { vendor: 'OpenAI', input: 2, cachedInput: 0.2, output: 10, note: NOTE_272K },
      'gpt-6-luna': { vendor: 'OpenAI', input: 0.1, cachedInput: 0.01, output: 0.5, note: NOTE_272K },
      'gpt-5.6-sol': { vendor: 'OpenAI', input: 4, cachedInput: 0.4, output: 20, note: NOTE_272K },
      'gpt-5.6-terra': { vendor: 'OpenAI', input: 2, cachedInput: 0.2, output: 12, note: NOTE_272K },
      'gpt-5.5': { vendor: 'OpenAI', input: 5, cachedInput: 0.5, output: 30, note: NOTE_272K },
      'gemini-4-carbon': { vendor: 'Google', input: 4, cachedInput: 0.2, output: 20, note: standardFrom('2026-12-01') },
      'gemini-4-argon': { vendor: 'Google', input: 4, cachedInput: 0.2, output: 20, note: standardFrom('2026-12-01') },
      'gemini-4-hydrogen': { vendor: 'Google', input: 1.5, cachedInput: 0.075, output: 7.5 },
      'gemini-3.8-flash': { vendor: 'Google', input: 1.5, cachedInput: 0.15, output: 7.5, note: standardFrom('2027-01-01') },
      'gemini-3.5-flash-lite': { vendor: 'Google', input: 0.3, cachedInput: 0.03, output: 2.5 },
      // xAI: a bare name such as grok-4.7 is an alias for that model's latest stable release, so only a dated id is listed.
      'grok-4.20-0309-reasoning': { vendor: 'xAI', input: 1.25, cachedInput: 0.2, output: 2.5, note: NOTE_200K },
      // Open-weight models. The id names the weights release (`openWeights` is its Hugging Face repository), and the
      // price is the publisher's own API price for that release: one reference price for every way of serving it,
      // a runner's own hardware included, so rows compare. A run says how the model was served (--serving).
      'deepseek-v4.1-flash-1017': { vendor: 'DeepSeek', openWeights: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', input: 0.3, cachedInput: 0.006, output: 1.2, note: NOTE_PEAK },
      'deepseek-v4-pro-0813': { vendor: 'DeepSeek', openWeights: 'deepseek-ai/DeepSeek-V4-Pro-0813', input: 1.32, cachedInput: 0.044, output: 3.96, note: NOTE_PEAK },
      'qwen3.8-27b': { vendor: 'Alibaba', openWeights: 'Qwen/Qwen3.8-27B', input: 0.5, cachedInput: 0.5, output: 3, note: 'the publisher states no cached-input price for this model, so cached input is priced as fresh input' },
      'glm-5.3': { vendor: 'Z.ai', openWeights: 'zai-org/GLM-5.3', input: 1.4, cachedInput: 0.26, output: 4.4 },
      'glm-5.3-flash': { vendor: 'Z.ai', openWeights: 'zai-org/GLM-5.3-Flash', input: 0.15, cachedInput: 0.03, output: 0.5 },
      'minimax-m3.1-flash': { vendor: 'MiniMax', openWeights: 'MiniMaxAI/MiniMax-M3.1-Flash', input: 0.15, cachedInput: 0.015, output: 0.6 },
      'mistral-large-4': { vendor: 'Mistral', openWeights: 'mistralai/Mistral-Large-4-1T-A52B', input: 0.7, cachedInput: 0.07, output: 2.1 },
    },
  },
};

const own = (o, k) => Object.hasOwn(o, k);
const round4 = (n) => Math.round(n * 10_000) / 10_000;

// The price list of a suite. A suite with no list cannot be costed, so it cannot be run.
export function priceList(suite) {
  if (typeof suite !== 'string' || !own(PRICES, suite)) throw new Error(`no pinned price list for suite ${suite}: this copy of the coordinator knows ${Object.keys(PRICES).join(', ')}`);
  return PRICES[suite];
}

// One model's prices, or null when the suite does not price it.
export const priceOf = (list, model) => (typeof model === 'string' && own(list.models, model) ? list.models[model] : null);

export const pricedModels = (list, vendor = null) => Object.keys(list.models).filter((id) => !vendor || list.models[id].vendor === vendor).sort();

const count = (v, name) => {
  if (v === undefined || v === null) return 0;
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a number of tokens, 0 or more`);
  return v;
};

// What these tokens cost at one model's pinned prices, in the list's currency, to four decimals.
// `input` is fresh input, `cachedInput` input read from the provider's cache, `cacheWrite` input
// written to it (billed as fresh input where the provider has no separate price), `output` output.
export function tokenCost(price, tokens = {}, per = 1_000_000) {
  const t = { input: count(tokens.input, 'input'), cachedInput: count(tokens.cachedInput, 'cachedInput'), cacheWrite: count(tokens.cacheWrite, 'cacheWrite'), output: count(tokens.output, 'output') };
  const usd = t.input * price.input + t.cachedInput * price.cachedInput + t.cacheWrite * (price.cacheWrite ?? price.input) + t.output * price.output;
  return round4(usd / per);
}
