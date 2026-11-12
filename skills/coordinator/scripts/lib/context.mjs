// Where a run's tokens went, from Claude Code transcript files (JSONL). Pure:
// the CLI streams each file's lines in. Nothing from a transcript's text is kept
// or printed: only counts, model names, agent types and file names.
//
// One assistant message is written as several lines (one per content block)
// that repeat the same usage, so a message counts once, keyed by its id.
// A turn's context is what the model read: input + cache read + cache write.
// Weights are relative prices, not money: they rank the shares, and a person
// reading a bill should trust the bill.
//
// Rounds: every brief run.mjs prints starts with a marker line (lib/briefs.mjs)
// naming its run, unit, round and role. A sub-agent's turns after a marker are
// that round's, so a second marker in one transcript is a resumed agent.
import { parseBriefMark } from './briefs.mjs';

export const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
export const BIG_RESULT_CHARS = 10_000;
export const CACHE_MINUTES = 60;

const num = (v) => (Number.isFinite(v) ? v : 0);
const msOf = (t) => { const n = Date.parse(t); return Number.isFinite(n) ? n : null; };
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const share = (part, whole) => (whole > 0 ? round((100 * part) / whole) : 0);

function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, c) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0);
}

// What a person or the lead wrote to the agent: the prompt, or a later message. Tool results are not read for markers.
function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n');
}
const markKey = (m) => `${m.run}|${m.unit ?? ''}|${m.round ?? ''}|${m.role}`;
const weigh = (t) => t.input * WEIGHTS.input + t.write * WEIGHTS.cacheWrite + t.read * WEIGHTS.cacheRead + t.output * WEIGHTS.output;

const isCompaction = (o) => o.isCompactSummary === true || o.subtype === 'compact_boundary';
// A background agent's "finished" notice reaching the lead (Claude Code writes it as a user turn).
const isNotice = (o) => o.type === 'user' && typeof o.message?.content === 'string' && o.message.content.trimStart().startsWith('<task-notification>');

// One agent's transcript (the lead's own, or one sub-agent's). add() every parsed line, then result().
export class AgentSummary {
  constructor({ id, agentType = null, main = false, cacheMinutes = CACHE_MINUTES } = {}) {
    this.id = id; this.agentType = agentType; this.main = main; this.cacheMs = cacheMinutes * 60_000;
    this.msgs = new Map(); this.compactions = 0; this.notices = 0; this.bigResults = 0; this.resultChars = 0; this.bigChars = 0;
    this.mark = null; this.marks = new Map();
  }

  add(o) {
    if (!o || typeof o !== 'object') return;
    if (isCompaction(o)) this.compactions++;
    if (isNotice(o)) this.notices++;
    if (!this.main && o.type === 'user') {
      const mk = parseBriefMark(promptText(o.message?.content));
      if (mk) { this.mark = markKey(mk); if (!this.marks.has(this.mark)) this.marks.set(this.mark, mk); }
    }
    if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type !== 'tool_result') continue;
        const n = resultChars(c.content);
        this.resultChars += n;
        if (n > BIG_RESULT_CHARS) { this.bigResults++; this.bigChars += n; }
      }
    }
    if (o.type !== 'assistant' || !o.message?.usage) return;
    const u = o.message.usage;
    const key = o.message.id ?? o.uuid;
    const prev = this.msgs.get(key);
    const m = {
      at: msOf(o.timestamp), model: o.message.model ?? null,
      input: num(u.input_tokens), write: num(u.cache_creation_input_tokens), read: num(u.cache_read_input_tokens),
      output: Math.max(num(u.output_tokens), prev?.output ?? 0),
      mark: prev ? prev.mark : this.mark,
    };
    this.msgs.set(key, prev ? { ...m, at: prev.at ?? m.at } : m);
  }

  result() {
    const turns = [...this.msgs.values()].filter((m) => m.model !== '<synthetic>');
    const t = { input: 0, write: 0, read: 0, output: 0 };
    let first = 0; let max = 0; let last = 0; let rewrites = 0; let rewriteTokens = 0; let prevAt = null;
    const models = new Map();
    const segs = new Map([...this.marks].map(([k, mk]) => [k, { ...mk, turns: 0, maxContext: 0, tokens: { input: 0, write: 0, read: 0, output: 0 } }]));
    turns.forEach((m, i) => {
      const ctx = m.input + m.write + m.read;
      const seg = m.mark ? segs.get(m.mark) : null;
      if (seg) { seg.turns++; seg.maxContext = Math.max(seg.maxContext, ctx); for (const k of ['input', 'write', 'read', 'output']) seg.tokens[k] += m[k]; }
      if (i === 0) first = ctx;
      max = Math.max(max, ctx); last = ctx;
      t.input += m.input; t.write += m.write; t.read += m.read; t.output += m.output;
      // The cache had expired between two turns, and most of the context was written again.
      if (i > 0 && m.at !== null && prevAt !== null && m.at - prevAt > this.cacheMs && m.write > 0.5 * ctx) { rewrites++; rewriteTokens += m.write; }
      if (m.at !== null) prevAt = m.at;
      if (m.model) models.set(m.model, (models.get(m.model) ?? 0) + 1);
    });
    const weighted = weigh(t);
    return {
      id: this.id, agentType: this.agentType, main: this.main,
      model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      turns: turns.length, firstContext: first, maxContext: max, lastContext: last,
      compactions: this.compactions, wakeNotices: this.notices,
      cacheRewrites: rewrites, cacheRewriteTokens: rewriteTokens,
      bigResults: this.bigResults, bigResultChars: this.bigChars, resultChars: this.resultChars,
      tokens: t, weighted: Math.round(weighted),
      // One row per brief this agent was given, in the order they arrived.
      rounds: [...segs.values()].map((s) => ({ ...s, weighted: Math.round(weigh(s.tokens)) })),
    };
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

// results: AgentSummary.result() rows. Returns the aggregates a retro quotes.
export function report(results, { top = 5 } = {}) {
  const live = results.filter((r) => r.turns > 0);
  const sum = (f) => live.reduce((n, r) => n + f(r), 0);
  const tokens = { input: sum((r) => r.tokens.input), cacheWrite: sum((r) => r.tokens.write), cacheRead: sum((r) => r.tokens.read), output: sum((r) => r.tokens.output) };
  const all = tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output;
  const weighted = sum((r) => r.weighted);
  const groups = new Map();
  for (const r of live) {
    const k = r.main ? 'lead' : r.agentType ?? 'unknown';
    const g = groups.get(k) ?? { group: k, agents: 0, turns: 0, weighted: 0, maxContext: 0 };
    g.agents++; g.turns += r.turns; g.weighted += r.weighted; g.maxContext = Math.max(g.maxContext, r.maxContext);
    groups.set(k, g);
  }
  const subs = live.filter((r) => !r.main);
  // By role and by round, from the brief markers. A sub-agent's turns before any marker (or with none) are "unmarked".
  const roles = new Map(); const rounds = new Map();
  const tally = (map, key, row, r, turns, w, ctx) => {
    const g = map.get(key) ?? { ...row, ids: new Set(), turns: 0, weighted: 0, maxContext: 0 };
    g.ids.add(r.id); g.turns += turns; g.weighted += w; g.maxContext = Math.max(g.maxContext, ctx);
    map.set(key, g);
  };
  for (const r of live) {
    if (r.main) { tally(roles, 'lead', { role: 'lead' }, r, r.turns, r.weighted, r.maxContext); continue; }
    const segs = r.rounds ?? [];
    for (const s of segs) {
      tally(roles, s.role, { role: s.role }, r, s.turns, s.weighted, s.maxContext);
      tally(rounds, markKey(s), { run: s.run, unit: s.unit, round: s.round, role: s.role }, r, s.turns, s.weighted, s.maxContext);
    }
    const turnsLeft = r.turns - sum2(segs, (s) => s.turns);
    if (turnsLeft > 0) tally(roles, 'unmarked', { role: 'unmarked' }, r, turnsLeft, Math.max(0, r.weighted - sum2(segs, (s) => s.weighted)), segs.length ? 0 : r.maxContext);
  }
  const rows = (map) => [...map.values()].map(({ ids, weighted: w, ...g }) => ({ ...g, agents: ids.size, weightedPct: share(w, weighted), w }));
  const strip = ({ w, ...g }) => g;
  const bigChars = sum((r) => r.bigResultChars);
  return {
    agents: live.length, turns: sum((r) => r.turns),
    tokens: { ...tokens, total: all },
    shares: { cachedReadPct: share(tokens.cacheRead, all), outputPct: share(tokens.output, all) },
    weights: WEIGHTS,
    costShareByGroup: [...groups.values()].sort((a, b) => b.weighted - a.weighted).map((g) => ({ ...g, weightedPct: share(g.weighted, weighted) })),
    subAgents: {
      count: subs.length, meanTurns: subs.length ? round(sum2(subs, (r) => r.turns) / subs.length) : 0,
      firstContextMedian: median(subs.map((r) => r.firstContext)),
      maxContextMedian: median(subs.map((r) => r.maxContext)),
      neverCompacted: subs.filter((r) => r.compactions === 0).length,
    },
    costShareByRole: rows(roles).sort((a, b) => b.w - a.w).map(strip),
    rounds: rows(rounds).sort((a, b) => a.run.localeCompare(b.run) || (a.unit === null) - (b.unit === null) || String(a.unit).localeCompare(String(b.unit)) || (a.round ?? 0) - (b.round ?? 0) || a.role.localeCompare(b.role)).map(strip),
    resumedAgents: subs.filter((r) => (r.rounds ?? []).length > 1).length,
    lead: live.filter((r) => r.main).map((r) => ({ turns: r.turns, maxContext: r.maxContext, compactions: r.compactions, wakeNotices: r.wakeNotices })),
    largest: [...live].sort((a, b) => b.weighted - a.weighted).slice(0, top).map((r) => ({
      id: r.id, group: r.main ? 'lead' : r.agentType ?? 'unknown', model: r.model, turns: r.turns, maxContext: r.maxContext,
      compactions: r.compactions, weightedPct: share(r.weighted, weighted),
    })),
    cacheRewrites: { count: sum((r) => r.cacheRewrites), tokens: sum((r) => r.cacheRewriteTokens), weightedPct: share(sum((r) => r.cacheRewriteTokens) * (WEIGHTS.cacheWrite - WEIGHTS.cacheRead), weighted) },
    bigToolResults: { count: sum((r) => r.bigResults), charSharePct: share(bigChars, sum((r) => r.resultChars)), overChars: BIG_RESULT_CHARS },
  };
}

function sum2(xs, f) { return xs.reduce((n, x) => n + f(x), 0); }
