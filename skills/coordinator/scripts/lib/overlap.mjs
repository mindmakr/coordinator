// Parallel units that change the same files (#37): once one of them merges,
// the others conflict in those files unless the target is merged into their
// branch first. A unit's files are the ones the lead planned for it
// (`run.mjs touches <run> <path> --unit U`) plus those in its last checked diff
// (detect.mjs). Merges are `link --merge`; `run.mjs sync` records that the
// target was merged in. Pure.

const MAX_SHOWN = 4;
export const normPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');

export function unitPaths(u) {
  return new Set([...(u.touches ?? []), ...(u.detect?.paths ?? [])].map(normPath).filter(Boolean));
}

const lastMerge = (u) => (u.links ?? []).filter((l) => l.kind === 'merge' && l.at).map((l) => l.at).sort().at(-1) ?? null;

// unit id → the merged units it overlaps since it last took the target in, with the shared paths.
export function pendingSyncs(run) {
  const out = new Map();
  const merged = run.units.map((u) => ({ u, at: lastMerge(u) })).filter((m) => m.at);
  for (const u of run.units) {
    if (u.status === 'stopped' || lastMerge(u)) continue;
    const mine = unitPaths(u);
    if (!mine.size) continue;
    const list = [];
    for (const m of merged) {
      if (m.u.id === u.id || (u.syncedAt && u.syncedAt >= m.at)) continue;
      const shared = [...unitPaths(m.u)].filter((p) => mine.has(p)).sort();
      if (shared.length) list.push({ unit: m.u.id, at: m.at, paths: shared });
    }
    if (list.length) out.set(u.id, list);
  }
  return out;
}

const shown = (paths) => (paths.length > MAX_SHOWN ? `${paths.slice(0, MAX_SHOWN).join(', ')} and ${paths.length - MAX_SHOWN} more` : paths.join(', '));

// "u3 overlaps u1 in content/en.json: merge the target into u3 before review, then run.mjs sync <run> u3"
export function syncStep(runId, id, list, passed = false) {
  const what = list.map((x) => `${x.unit} in ${shown(x.paths)}`).join('; ');
  return `${id} overlaps ${what}, merged already: merge the target into ${id} before ${passed ? 'merging' : 'review'}, then run.mjs sync ${runId} ${id}`;
}
