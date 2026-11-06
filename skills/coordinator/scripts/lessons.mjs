#!/usr/bin/env node
// What past runs taught: short lessons, merged when they say the same thing,
// ranked by how often they recur and are used, pruned so loading stays cheap.
//
//   lessons.mjs add --tag T --text "one sentence" [--from run] [--source URL …] [--scope global|project]
//                   T is free: code, security, design, ux, stack, … --source is where it was learned (a study, a doc)
//   lessons.mjs list [--tag T] [--top 8] [--scope …]      promote: true once seen 3+ times
//   lessons.mjs use <id> | drop <id> [--scope …]
//   lessons.mjs prune [--keep 60] [--scope …]
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { num, oneOf, optText, parse, text } from './lib/args.mjs';
import { webUrl } from './lib/links.mjs';
import { tokens } from './lib/rules.mjs';
import { findSecret } from './lib/secrets.mjs';
import { baseDir, readJson, safeId, update } from './lib/store.mjs';

const FLAGS = { add: ['tag', 'text', 'from', 'source', 'scope'], list: ['tag', 'top', 'scope'], use: ['scope'], drop: ['scope'], prune: ['keep', 'scope'] };
const norm = (s) => tokens(s).join(' ');
const idOf = (s) => createHash('sha256').update(norm(s)).digest('hex').slice(0, 10);
const rank = (l) => l.seen * 2 + l.used;

// Near-duplicates must say the same thing in the same order: "migrations before
// seed" and "seed before migrations" share every word but are opposite lessons.
const NEGATION = new Set(['not', 'never', 'no', 'dont', 'don', 'avoid', 'without', 'stop', 'always', 'must', 'only', 'before', 'after', 'لا', 'نہ', 'نہیں', 'مت', 'نه', '不', '没', '别']);
function similar(a, b) {
  const x = norm(a).split(' '); const y = norm(b).split(' ');
  // Different negations or ordering words ("always" vs "never", "before" vs "after") mean different lessons.
  const neg = (w) => w.filter((t) => NEGATION.has(t)).join(' ');
  if (neg(x) !== neg(y)) return false;
  // Shared words must appear in the same order: "seed before migrations" is not "migrations before seed".
  const shared = new Set(x.filter((t) => y.includes(t)));
  const order = (w) => [...new Set(w.filter((t) => shared.has(t)))].join(' ');
  if (order(x) !== order(y)) return false;
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) {
    dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  return dp[x.length][y.length] / Math.max(x.length, y.length) >= 0.8;
}
const byRank = (a, b) => rank(b) - rank(a) || b.lastAt.localeCompare(a.lastAt);

function main(cmd, pos, opt) {
  const file = join(baseDir(oneOf(opt.scope ?? 'global', ['global', 'project'], '--scope')), 'lessons.json');
  const now = new Date().toISOString();
  const touch = (id, field) => update(file, [], (all) => {
    const l = all.find((x) => x.id === id);
    if (!l) throw new Error(`no lesson ${id}`);
    l[field]++; l.lastAt = now;
  });
  switch (cmd) {
    case 'add': {
      if (typeof opt.text === 'string' && findSecret(opt.text)) throw new Error('refused: the text looks like it contains a secret');
      const t = text(opt.text, 'text', 300);
      const tag = safeId(opt.tag ?? 'general', 'tag');
      const from = optText(opt.from, 64);
      const sources = (opt.source ?? []).map((raw) => {
        const url = typeof raw === 'string' ? webUrl(raw.trim()) : null;
        if (!url || url.length > 500) throw new Error(`--source must be an http(s) URL, got: ${raw}`);
        if (findSecret(url)) throw new Error('refused: the source looks like it contains a secret');
        return url;
      });
      let result;
      update(file, [], (all) => {
        const hit = all.find((l) => l.id === idOf(t) || (l.tag === tag && similar(l.text, t)));
        if (hit) {
          hit.seen++; hit.lastAt = now;
          if (from && !hit.from.includes(from)) hit.from.push(from);
          for (const u of sources) if (!(hit.sources ??= []).includes(u)) hit.sources.push(u);
          result = { id: hit.id, added: false, mergedInto: hit.text };
          return;
        }
        all.push({ id: idOf(t), tag, text: t, seen: 1, used: 0, firstAt: now, lastAt: now, from: from ? [from] : [], ...(sources.length ? { sources } : {}) });
        result = { id: idOf(t), added: true };
      });
      return result;
    }
    case 'list':
      return readJson(file, []).filter((l) => !opt.tag || l.tag === opt.tag || l.tag === 'general').sort(byRank)
        .slice(0, num(opt.top, 8, 1, 200)).map(({ id, tag, text: t, seen, used, from, sources }) => ({ id, tag, seen, used, promote: seen >= 3, text: t, from: from ?? [], ...(sources?.length ? { sources } : {}) }));
    case 'use': touch(safeId(pos[0], 'lesson id'), 'used'); return { id: pos[0], used: true };
    case 'drop': {
      const id = safeId(pos[0], 'lesson id');
      update(file, [], (all) => { if (!all.some((x) => x.id === id)) throw new Error(`no lesson ${id}`); return all.filter((x) => x.id !== id); });
      return { id, dropped: true };
    }
    case 'prune': {
      const keep = num(opt.keep, 60, 1, 1000);
      let removed = 0;
      update(file, [], (all) => { const kept = [...all].sort(byRank).slice(0, keep); removed = all.length - kept.length; return kept; });
      return { keep, removed };
    }
    default: throw new Error('usage: lessons.mjs add|list|use|drop|prune … (see the header of lessons.mjs)');
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  const { pos, opt } = parse(rest, FLAGS[cmd] ?? [], cmd === 'add' ? ['source'] : []);
  console.log(JSON.stringify(main(cmd, pos, opt), null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exit(cmd in FLAGS ? 1 : 2); }
