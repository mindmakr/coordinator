// context: where a run's tokens went, from transcript lines. Counts only, no transcript text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentSummary, report, WEIGHTS } from '../lib/context.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'coord-context-'));
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-01T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const asst = (id, min, { input = 2, write = 0, read = 0, output = 10, model = 'claude-opus-5-5' } = {}) => ({
  type: 'assistant', timestamp: at(min), uuid: `u-${id}-${min}`,
  message: { id, model, content: [], usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output } },
});
const result = (chars) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(chars) }] } });
const run = (lines, o = {}) => { const s = new AgentSummary(o); lines.forEach((l) => s.add(l)); return s.result(); };

test('one message written as several lines counts once, with its largest output', () => {
  const r = run([asst('m1', 0, { write: 1000, output: 5 }), asst('m1', 0, { write: 1000, output: 40 }), asst('m1', 0, { write: 1000, output: 40 })]);
  assert.equal(r.turns, 1);
  assert.equal(r.tokens.write, 1000);
  assert.equal(r.tokens.output, 40);
});

test('context is input plus cache read plus cache write; first, max and last are tracked', () => {
  const r = run([asst('a', 0, { write: 70_000 }), asst('b', 1, { read: 70_000, write: 10_000 }), asst('c', 2, { read: 80_000, write: 5_000 })]);
  assert.equal(r.firstContext, 70_002);
  assert.equal(r.maxContext, 85_002);
  assert.equal(r.lastContext, 85_002);
  assert.equal(r.weighted, Math.round(6 * WEIGHTS.input + 85_000 * WEIGHTS.cacheWrite + 150_000 * WEIGHTS.cacheRead + 30 * WEIGHTS.output));
});

test('a pause longer than the cache lifetime that rewrites most of the context is a cache rewrite', () => {
  const lines = [asst('a', 0, { write: 200_000 }), asst('b', 5, { read: 200_000, write: 1_000 }), asst('c', 120, { write: 190_000, read: 10_000 })];
  const r = run(lines);
  assert.equal(r.cacheRewrites, 1);
  assert.equal(r.cacheRewriteTokens, 190_000);
  assert.equal(run(lines, { cacheMinutes: 180 }).cacheRewrites, 0);
  // A long pause with the cache still warm is not a rewrite.
  assert.equal(run([asst('a', 0, { write: 1000 }), asst('b', 120, { read: 1000, write: 10 })]).cacheRewrites, 0);
});

test('compactions, finished-agent notices and tool results over 10k characters are counted', () => {
  const r = run([
    { type: 'user', isCompactSummary: true, message: { content: 'x' } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', message: { content: '<task-notification>agent done</task-notification>' } },
    { type: 'user', message: { content: 'a normal message' } },
    result(10_001), result(10_000), result(50),
    asst('a', 0, { read: 5 }),
  ]);
  assert.equal(r.compactions, 2);
  assert.equal(r.wakeNotices, 1);
  assert.equal(r.bigResults, 1);
  assert.equal(r.bigResultChars, 10_001);
  assert.equal(r.resultChars, 20_051);
});

test('report: shares, groups, sub-agent sizes and the costliest agents', () => {
  const lead = run([asst('l1', 0, { read: 900_000, write: 1000 }), asst('l2', 1, { read: 900_000, output: 100 })], { id: 'lead', main: true });
  const b1 = run([asst('b1', 0, { write: 75_000 }), asst('b2', 1, { read: 75_000, write: 5_000 })], { id: 'b-1', agentType: 'general-purpose' });
  const b2 = run([asst('c1', 0, { write: 75_000 })], { id: 'b-2', agentType: 'general-purpose' });
  const c1 = run([asst('d1', 0, { write: 20_000, model: 'claude-sonnet-5-5' })], { id: 'c-1', agentType: 'ecc:code-reviewer' });
  const empty = run([], { id: 'nothing' });
  const rep = report([lead, b1, b2, c1, empty], { top: 2 });
  assert.equal(rep.agents, 4);
  assert.equal(rep.subAgents.count, 3);
  assert.equal(rep.subAgents.firstContextMedian, 75_002);
  assert.equal(rep.subAgents.neverCompacted, 3);
  assert.equal(rep.largest.length, 2);
  assert.equal(rep.largest[0].group, 'lead');
  assert.deepEqual(rep.costShareByGroup.map((g) => g.group).sort(), ['ecc:code-reviewer', 'general-purpose', 'lead']);
  const pct = rep.costShareByGroup.reduce((n, g) => n + g.weightedPct, 0);
  assert.ok(Math.abs(pct - 100) < 0.5, `shares add to 100, got ${pct}`);
  assert.ok(rep.shares.cachedReadPct > 90);
  assert.ok(rep.shares.outputPct < 1);
});

test('the CLI reads a session folder, tells sub-agents from the lead, and prints no transcript text', () => {
  const dir = join(root, 'session');
  mkdirSync(join(dir, 'subagents'), { recursive: true });
  const SECRET = 'PRIVATE-PROMPT-TEXT';
  const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, 'main.jsonl'), jl([{ type: 'user', message: { content: SECRET } }, asst('l1', 0, { write: 5000 }), asst('l2', 1, { read: 5000 })]));
  writeFileSync(join(dir, 'subagents', 'agent-a1.jsonl'), jl([{ type: 'user', message: { content: SECRET } }, asst('s1', 0, { write: 3000 })]) + '{"torn');
  writeFileSync(join(dir, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: SECRET }));
  const r = spawnSync(process.execPath, [join(scripts, 'context.mjs'), dir, '--top', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(SECRET));
  const out = JSON.parse(r.stdout);
  assert.equal(out.files, 2);
  assert.equal(out.subAgents.count, 1);
  assert.deepEqual(out.costShareByGroup.map((g) => g.group).sort(), ['general-purpose', 'lead']);
  assert.equal(out.largest.length, 1);
});

test('the CLI refuses a missing path, a folder with no transcripts and a bad option; --help exits 0', () => {
  const run2 = (...a) => spawnSync(process.execPath, [join(scripts, 'context.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(run2(join(root, 'nope')).status, 2);
  mkdirSync(join(root, 'empty'), { recursive: true });
  assert.match(run2(join(root, 'empty')).stderr, /no \.jsonl/);
  assert.match(run2(root, '--top', '0').stderr, /--top/);
  assert.equal(run2().status, 2);
  const h = run2('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Where a run's tokens went/);
});
