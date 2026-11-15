// The lead's context budget, checked rather than remembered (the perf plan, cause K: leads reached 280k-456k with no
// compaction). next reads the lead's own transcript for its usage numbers only (never its text): over WARN it
// warns, and over MAX every lead step is refused until the window compacts (its context falls) or the lead writes a
// handover note (note --kind decision --text "handover: …") after it went over. The transcript is found by the
// tool's session id (lib/lead.mjs SESSION_VARS), or named by COORDINATOR_TRANSCRIPT. A tool with neither: no check.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WARN = 250_000;
export const MAX = 300_000;
const TAIL = 4 << 20; // the last 4 MB: hundreds of turns, enough to see the latest usage and when it went over

// The transcript file of this window, or null.
export function transcriptPath(env = process.env, home = homedir()) {
  if (env.COORDINATOR_TRANSCRIPT) return existsSync(env.COORDINATOR_TRANSCRIPT) ? env.COORDINATOR_TRANSCRIPT : null;
  const sid = env.CLAUDE_CODE_SESSION_ID;
  if (!sid || !/^[A-Za-z0-9-]{8,80}$/.test(sid)) return null;
  const root = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
  try {
    for (const d of readdirSync(root)) { const f = join(root, d, `${sid}.jsonl`); if (existsSync(f)) return f; }
  } catch { /* no projects folder */ }
  return null;
}

// The context size of each assistant turn since the last compaction, from transcript lines: [{ at, tokens }].
// Only these numbers are read: input, cache-read and cache-write tokens of each message's usage.
export function usages(text) {
  let out = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes('"usage"') && !line.includes('compact_boundary')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // the first, cut line of a tail
    if (e?.type === 'system' && e.subtype === 'compact_boundary') { out = []; continue; }
    const u = e?.message?.usage;
    if (e?.type !== 'assistant' || !u || e.isSidechain) continue;
    const tokens = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
    out.push({ at: typeof e.timestamp === 'string' ? e.timestamp : null, tokens });
  }
  return out;
}

// The end of a file, as text (the whole file when it is smaller than TAIL).
export function tail(file, bytes = TAIL) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size; const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

// { tokens, level: ok|warn|over, since?, text? } from the usages and the run's notes; null with no usage.
export function budgetCheck(list, notes = []) {
  const last = list.at(-1);
  if (!last) return null;
  const k = (n) => `${Math.round(n / 1000)}k`;
  if (last.tokens <= WARN) return { tokens: last.tokens, level: 'ok' };
  if (last.tokens <= MAX) return { tokens: last.tokens, level: 'warn', text: `the lead's context is ${k(last.tokens)} (warn at ${k(WARN)}, lead steps stop at ${k(MAX)}): compact at the next pit stop, or hand over (note --kind decision --text "handover: …")` };
  // Over: since the first turn over MAX in this stretch (after the last compaction), a handover note lifts it.
  let i = list.length - 1; while (i > 0 && list[i - 1].tokens > MAX) i--;
  const since = list[i].at;
  const handover = (notes ?? []).some((n) => n.kind === 'decision' && /^handover\b/i.test(n.text ?? '') && (!since || n.at >= since));
  if (handover) return { tokens: last.tokens, level: 'warn', since, text: `the lead's context is ${k(last.tokens)}, over ${k(MAX)}; a handover note is recorded: the next lead takes it from there` };
  return { tokens: last.tokens, level: 'over', since, text: `lead step refused: the lead's context is ${k(last.tokens)}, over ${k(MAX)}. Compact this window (/compact), or write the handover (run.mjs note <run> --kind decision --text "handover: …") so a fresh window can lead` };
}

// The check for this window: reads the transcript's tail. Null when there is no transcript or no usage.
export function leadBudget(notes, env = process.env) {
  const f = transcriptPath(env);
  if (!f) return null;
  try { return budgetCheck(usages(tail(f)), notes); } catch { return null; }
}
