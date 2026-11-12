#!/usr/bin/env node
// Where a run's tokens went, for the retro (references/context.md). Reads Claude
// Code transcript files and prints counts only: no transcript text is printed.
//
//   context.mjs <path> [<path> …] [--top N] [--cache-minutes M] [--json]
//   <path>  a session's .jsonl file, or a folder searched for .jsonl files (a
//           project folder under ~/.claude/projects, or one session's folder with
//           its subagents/ folder). Files under a subagents/ folder are sub-agents;
//           their agent type comes from the .meta.json file beside them.
//   --top N            how many of the costliest agents to list (default 5)
//   --cache-minutes M  how long the prompt cache lives (default 60)
//
// Prints: tokens by kind, the share read from cache, cost share by agent type
// (relative weights, not money), sub-agent context sizes and compactions, the
// lead's own, the costliest agents, cache rewrites after a pause longer than the
// cache lifetime, and tool results over 10k characters.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { helpAndExit, parse } from './lib/args.mjs';
import { AgentSummary, report } from './lib/context.mjs';

helpAndExit(import.meta.url);

function jsonlFiles(p) {
  const st = statSync(p);
  if (st.isFile()) return p.endsWith('.jsonl') ? [p] : [];
  return readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.name === 'tool-results' ? [] : jsonlFiles(join(p, e.name))));
}

function agentType(file) {
  const meta = file.replace(/\.jsonl$/, '.meta.json');
  if (!existsSync(meta)) return null;
  try { const t = JSON.parse(readFileSync(meta, 'utf8')).agentType; return typeof t === 'string' ? t : null; } catch { return null; }
}

async function summarise(file, cacheMinutes) {
  const sub = file.split(sep).includes('subagents');
  const s = new AgentSummary({ id: basename(file, '.jsonl'), agentType: sub ? agentType(file) : null, main: !sub, cacheMinutes });
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { s.add(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return s.result();
}

try {
  const { pos, opt } = parse(process.argv.slice(2), ['top', 'cache-minutes', 'json']);
  if (!pos.length) throw new Error('give a transcript file or a folder (see --help)');
  const top = opt.top === undefined ? 5 : Number(opt.top);
  const cacheMinutes = opt['cache-minutes'] === undefined ? 60 : Number(opt['cache-minutes']);
  if (!Number.isInteger(top) || top < 1 || top > 50) throw new Error('--top must be a whole number from 1 to 50');
  if (!(cacheMinutes > 0 && cacheMinutes <= 1440)) throw new Error('--cache-minutes must be a number from 1 to 1440');
  const files = [...new Set(pos.flatMap((p) => { const r = resolve(p); if (!existsSync(r)) throw new Error(`not found: ${p}`); return jsonlFiles(r); }))];
  if (!files.length) throw new Error('no .jsonl transcript files found');
  const results = [];
  for (const f of files) results.push(await summarise(f, cacheMinutes));
  const out = { files: files.length, ...report(results, { top }) };
  console.log(JSON.stringify(out, null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
