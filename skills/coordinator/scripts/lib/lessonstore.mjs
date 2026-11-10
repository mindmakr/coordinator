// The lessons files (`lessons.json` in the global and the project state folders): ranking, the top
// lessons for a run's tag, and counting a lesson as used. The `lessons.mjs` CLI edits them; `run.mjs
// brief` reads them so every builder and critic brief carries what past runs taught (references/learning.md).
import { join } from 'node:path';
import { readJson, update } from './store.mjs';

export const lessonsFile = (base) => join(base, 'lessons.json');
export const rank = (l) => l.seen * 2 + l.used;
export const byRank = (a, b) => rank(b) - rank(a) || String(b.lastAt).localeCompare(String(a.lastAt));
const valid = (l) => l !== null && typeof l === 'object' && typeof l.id === 'string' && typeof l.text === 'string';
const read = (base) => { const all = readJson(lessonsFile(base), []); return Array.isArray(all) ? all.filter(valid) : []; };

// The best lessons for `tag` (and the general ones) across the state folders, best first, each once.
// Each carries `base`, the folder it came from.
export function topLessons(bases, tag, top = 5) {
  const seen = new Set(); const all = [];
  for (const base of new Set(bases)) {
    for (const l of read(base)) {
      if (seen.has(l.id) || (tag && l.tag !== tag && l.tag !== 'general')) continue;
      seen.add(l.id); all.push({ ...l, base });
    }
  }
  return all.sort(byRank).slice(0, top);
}

// Counts each lesson as used once per run: `used` rises the first time a brief of that run carries it,
// so the ranking learns which lessons keep mattering without the lead running `lessons.mjs use` by hand.
export function markUsed(lessons, run, now = new Date().toISOString()) {
  let counted = 0;
  for (const base of new Set(lessons.map((l) => l.base))) {
    const ids = new Set(lessons.filter((l) => l.base === base).map((l) => l.id));
    update(lessonsFile(base), [], (all) => {
      for (const l of Array.isArray(all) ? all : []) {
        if (!valid(l) || !ids.has(l.id)) continue;
        const runs = Array.isArray(l.usedIn) ? l.usedIn : (l.usedIn = []);
        if (runs.includes(run)) continue;
        runs.push(run); if (runs.length > 30) runs.shift();
        l.used = (l.used ?? 0) + 1; l.lastAt = now; counted++;
      }
    });
  }
  return counted;
}
