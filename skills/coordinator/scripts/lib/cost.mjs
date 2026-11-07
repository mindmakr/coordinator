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
// "0.42 USD" or "USD 0.42": an amount and a three-letter currency code.
function money(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const after = /^(\d+(?:\.\d+)?)\s*([A-Za-z]{3})$/.exec(s);
  const before = /^([A-Za-z]{3})\s*(\d+(?:\.\d+)?)$/.exec(s);
  const [amount, currency] = after ? [after[1], after[2]] : before ? [before[2], before[1]] : [];
  if (amount === undefined || Number(amount) > 1e6) throw new Error(`--cost must be an amount and a currency code, e.g. "0.42 USD", got: ${v}`);
  return { amount: Math.round(Number(amount) * 10_000) / 10_000, currency: currency.toUpperCase() };
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

const empty = () => ({ entries: 0, tokensIn: 0, tokensOut: 0, minutes: 0, money: {} });
function add(sum, e) {
  sum.entries++;
  if (Number.isFinite(e.tokensIn)) sum.tokensIn += e.tokensIn;
  if (Number.isFinite(e.tokensOut)) sum.tokensOut += e.tokensOut;
  if (Number.isFinite(e.minutes)) sum.minutes = Math.round((sum.minutes + e.minutes) * 100) / 100;
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
  if (sum.tokensIn || sum.tokensOut) parts.push(`${k(sum.tokensIn)} in / ${k(sum.tokensOut)} out tokens`);
  if (sum.minutes) parts.push(`${sum.minutes} min`);
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
