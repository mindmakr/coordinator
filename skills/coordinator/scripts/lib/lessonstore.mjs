// The lessons files (`lessons.json` in the global and the project state folders): ranking, the top
// lessons for a run's tag, and counting a lesson as used. The `lessons.mjs` CLI edits them; `run.mjs
// brief` reads them so every builder and critic brief carries what past runs taught (references/learning.md).
import { join } from 'node:path';
import { readJson, update } from './store.mjs';

export const lessonsFile = (base) => join(base, 'lessons.json');
// A lesson ranks by how often it recurred (seen), then by how recently: never by how often briefs carried it, which
// only rose because it ranked high (the same five lessons rode in every brief while 50 of 69 were never shown).
export const rank = (l) => l.seen;
export const byRank = (a, b) => rank(b) - rank(a) || String(b.lastAt).localeCompare(String(a.lastAt));
const carried = (l) => l.used ?? 0; // every run that carried it (usedIn keeps only the last 30)
// For a brief: of the lessons that recurred as often, the ones carried in fewer runs first, so hints rotate.
const byBrief = (a, b) => rank(b) - rank(a) || carried(a) - carried(b) || String(b.lastAt).localeCompare(String(a.lastAt));
const valid = (l) => l !== null && typeof l === 'object' && typeof l.id === 'string' && typeof l.text === 'string';
const read = (base) => { const all = readJson(lessonsFile(base), []); return Array.isArray(all) ? all.filter(valid) : []; };

// The best lessons for `tag` (and the general ones) across the state folders, best first, each once. A lesson
// marked --check is left out: the scripts enforce it, so a hint would only spend the brief. Each carries `base`.
export function topLessons(bases, tag, top = 5) {
  const seen = new Set(); const all = [];
  for (const base of new Set(bases)) {
    for (const l of read(base)) {
      if (seen.has(l.id) || l.check || (tag && l.tag !== tag && l.tag !== 'general')) continue;
      seen.add(l.id); all.push({ ...l, base });
    }
  }
  return all.sort(byBrief).slice(0, top);
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
        l.used = (l.used ?? 0) + 1; l.lastUsedAt = now; counted++; // lastAt stays when it was last learned: ranking reads it
      }
    });
  }
  return counted;
}

// The checks in force for a run (run.mjs init prints them): what the scripts enforce, then each lesson made a check
// (lessons.mjs mark <id> --check …). A lesson marked advisory, or not marked, stays a hint in the briefs.
export const SCRIPT_CHECKS = [
  'suite: one full suite per head, run by the lead under the machine-wide suite lock (run.mjs suite); critics cite it',
  'precheck: built refuses a head whose precheck has a hit (run.mjs precheck; rules in "precheck" of .coordinator/coordinator.json)',
  'changelog: units never edit CHANGELOG.md; built --changelog stores the line, run.mjs changelog prints them for the release PR',
  'behaviours: add, behave and freeze refuse never/any/all/cannot/only/always/every/nothing unless the cases are listed or --open says why',
  'same behaviour: next asks the person after the same behaviour fails twice',
  'same files: next asks the person after two failing rounds in a row change the same files',
  'one critic: from round 2, a delta under 200 lines gets one critic (the specialist when the unit has one)',
  'paths: a unit whose --paths overlap a unit being built waits; separate paths build together',
  'batch: small follow-ups (followup --triage batch) build last as one unit',
  'lead context: next warns at 250k tokens and lead steps stop over 300k until a compaction or a handover note',
];
export function checksInForce(bases, { off = [] } = {}) {
  const seen = new Set(); const lessons = [];
  for (const base of new Set(bases)) for (const l of read(base)) if (l.check && !seen.has(l.id)) { seen.add(l.id); lessons.push(`lesson ${l.id}: ${l.check}`); }
  return [...SCRIPT_CHECKS.filter((c) => !off.some((o) => c.startsWith(`${o}:`))), ...lessons];
}
