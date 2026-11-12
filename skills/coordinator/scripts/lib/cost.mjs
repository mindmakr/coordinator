// What each launch cost, as the harness reported it: tokens in and out,
// minutes, and money with its currency. The lead passes them to `start`,
// `built` and `verdict` (--tokens-in, --tokens-out, --minutes, --cost "0.42 USD");
// each becomes one entry in the unit's `costs` list. Nothing is estimated:
// a missing figure stays missing and shows as "not recorded". Pure.

export const COST_FLAGS = ['tokens-in', 'tokens-out', 'minutes', 'cost'];
const NONE = 'not recorded';

function whole(v, name) {
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v.trim())) throw new Error(`--${name} must be a whole number of tokens, got: ${v}`);
  return Number(v.trim());
}
function decimal(v, name, max) {
  const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n > max) throw new Error(`--${name} must be a number from 0 to ${max}, got: ${v}`);
  return Math.round(n * 100) / 100;
}
// Active ISO 4217 codes (plus XAU/XAG metals left out): anything else is a typo, not a currency.
const ISO4217 = new Set(('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD '
  + 'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD '
  + 'HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD '
  + 'MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG '
  + 'QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD '
  + 'TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG').split(' '));

// "0.42 USD" or "USD 0.42": an amount and an ISO 4217 currency code.
function money(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const after = /^(\d+(?:\.\d+)?)\s*([A-Za-z]{3})$/.exec(s);
  const before = /^([A-Za-z]{3})\s*(\d+(?:\.\d+)?)$/.exec(s);
  const [amount, currency] = after ? [after[1], after[2]] : before ? [before[2], before[1]] : [];
  if (amount === undefined || Number(amount) > 1e6) throw new Error(`--cost must be an amount and a currency code, e.g. "0.42 USD", got: ${v}`);
  if (!ISO4217.has(currency.toUpperCase())) throw new Error(`--cost: ${currency} is not an ISO 4217 currency code (USD, EUR, GBP, SAR, …)`);
  return { amount: Math.round(Number(amount) * 10_000) / 10_000, currency: currency.toUpperCase() };
}

// The caps for one agent launch (guardrails.md, "Budget"): minutes (1-600) and money ("0.50 USD").
// The harness reports the figures after the launch, so a cap is checked then: an entry over it
// is flagged and noted, never refused (the work is already done).
export function launchCostProblem(v) {
  try { money(v); return null; } catch (e) { return e.message.replace('--cost', 'the launch cost'); }
}
export const launchCost = (v) => { const p = launchCostProblem(v); if (p) throw new Error(p.replace('the launch cost', '--max-launch-cost')); return money(v); };

// Plain words for each cap this entry went over; [] when none (or nothing comparable was recorded).
export function overLaunch(entry, caps) {
  if (!entry || !caps) return [];
  const out = [];
  if (Number.isFinite(caps.minutes) && Number.isFinite(entry.minutes) && entry.minutes > caps.minutes) out.push(`${entry.minutes} min, over the ${caps.minutes} min cap for one launch`);
  if (caps.cost && entry.cost && entry.cost.currency === caps.cost.currency && entry.cost.amount > caps.cost.amount) out.push(`${entry.cost.amount} ${entry.cost.currency}, over the ${caps.cost.amount} ${caps.cost.currency} cap for one launch`);
  return out;
}

// The cost entry from a command's options, or null when none was given.
export function costEntry(o, { step, role, model = null, at }) {
  if (!COST_FLAGS.some((k) => o[k] !== undefined)) return null;
  const e = { step, role, ...(model ? { model } : {}), at };
  if (o['tokens-in'] !== undefined) e.tokensIn = whole(o['tokens-in'], 'tokens-in');
  if (o['tokens-out'] !== undefined) e.tokensOut = whole(o['tokens-out'], 'tokens-out');
  if (o.minutes !== undefined) e.minutes = decimal(o.minutes, 'minutes', 100_000);
  if (o.cost !== undefined) e.cost = money(o.cost);
  return e;
}

// `recorded` says which figures any entry carried, so a recorded 0 shows as 0, not "not recorded".
const empty = () => ({ entries: 0, tokensIn: 0, tokensOut: 0, minutes: 0, money: {}, recorded: { tokensIn: false, tokensOut: false, minutes: false } });
function add(sum, e) {
  sum.entries++;
  if (Number.isFinite(e.tokensIn)) { sum.tokensIn += e.tokensIn; sum.recorded.tokensIn = true; }
  if (Number.isFinite(e.tokensOut)) { sum.tokensOut += e.tokensOut; sum.recorded.tokensOut = true; }
  if (Number.isFinite(e.minutes)) { sum.minutes = Math.round((sum.minutes + e.minutes) * 100) / 100; sum.recorded.minutes = true; }
  if (e.cost && Number.isFinite(e.cost.amount)) sum.money[e.cost.currency] = Math.round(((sum.money[e.cost.currency] ?? 0) + e.cost.amount) * 10_000) / 10_000;
  return sum;
}
const entries = (u) => (Array.isArray(u?.costs) ? u.costs.filter((e) => e && typeof e === 'object') : []);

export const unitCost = (u) => entries(u).reduce(add, empty());
export const runCost = (run) => run.units.flatMap(entries).reduce(add, empty());

// Per model, over every unit of the given runs; an entry with no model groups as "(not recorded)".
export function costByModel(runs) {
  const groups = new Map();
  for (const run of runs) for (const u of run.units) for (const e of entries(u)) {
    const key = e.model ?? '(not recorded)';
    groups.set(key, add(groups.get(key) ?? empty(), e));
  }
  return [...groups].map(([model, sum]) => ({ model, ...sum })).sort((a, b) => a.model.localeCompare(b.model));
}

const k = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
// "12.3k in / 4.1k out tokens · 34 min · 0.42 USD", or "not recorded".
export function costLine(sum) {
  if (!sum?.entries) return NONE;
  const parts = [];
  const r = sum.recorded ?? {};
  const tok = [r.tokensIn ? `${k(sum.tokensIn)} in` : null, r.tokensOut ? `${k(sum.tokensOut)} out` : null].filter(Boolean);
  if (tok.length) parts.push(`${tok.join(' / ')} tokens`);
  if (r.minutes) parts.push(`${sum.minutes} min`);
  for (const [cur, amt] of Object.entries(sum.money).sort()) parts.push(`${amt} ${cur}`);
  return parts.length ? parts.join(' · ') : NONE;
}

// The summary `stats` prints across closed runs: per run, per unit and per model.
export function costStats(runs) {
  return {
    costByRun: runs.map((r) => ({ run: r.id, ...runCost(r), line: costLine(runCost(r)) })),
    costByUnit: runs.flatMap((r) => r.units.map((u) => ({ run: r.id, unit: u.id, line: costLine(unitCost(u)) }))),
    costByModel: costByModel(runs).map((m) => ({ ...m, line: costLine(m) })),
  };
}
