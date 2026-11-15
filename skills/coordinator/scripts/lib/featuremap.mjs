// Unified feature-map.json contract loader and UI bar validator (#158).
// Reads live + static Reins/Coordinator app contracts inside the project root,
// validates unit bars/behaviours cite registered action/panel IDs (unless marked
// new), and merges live surfaces into the Coordinator project map.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const MAX_MAP_BYTES = 2 * 1024 * 1024;
const DEFAULT_PATHS = ['feature-map.json', join('.reins', 'feature-map.json')];
const ID_PART = '[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}';

const isObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const sortedUnique = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x.length > 0))].sort();

function resolveContained(root, candidate) {
  if (!root || !candidate || typeof candidate !== 'string') return null;
  if (isAbsolute(candidate)) {
    const rel = relative(resolve(root), resolve(candidate));
    if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error(`feature-map path must stay inside project root: ${candidate}`);
    }
  }
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, candidate);
  const rel = relative(absRoot, absTarget);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`feature-map path must stay inside project root: ${candidate}`);
  }
  return absTarget;
}

function assertRealContainment(root, absTarget) {
  const realRoot = realpathSync(resolve(root));
  const realTarget = realpathSync(absTarget);
  const rel = relative(realRoot, realTarget);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`feature-map symlink escapes project root: ${absTarget}`);
  }
  return realTarget;
}

/**
 * Finds and parses `feature-map.json` inside `root` (or explicit relative path).
 * Returns `{ found: false, ... }` when no default map file exists.
 */
export function findFeatureMap(root, explicitPath = null) {
  const empty = { found: false, path: null, actions: [], panels: [], states: [], routes: [], raw: null };
  if (!root) return empty;
  const candidates = explicitPath ? [explicitPath] : DEFAULT_PATHS;
  for (const cand of candidates) {
    const absTarget = resolveContained(root, cand);
    if (!absTarget || !existsSync(absTarget)) {
      if (explicitPath) throw new Error(`feature-map file not found: ${cand}`);
      continue;
    }
    const realTarget = assertRealContainment(root, absTarget);
    const st = statSync(realTarget);
    if (!st.isFile() || st.size > MAX_MAP_BYTES) {
      throw new Error(`feature-map exceeds ${MAX_MAP_BYTES} byte limit or is not a file: ${cand}`);
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(realTarget, 'utf8'));
    } catch (err) {
      throw new Error(`invalid JSON in ${cand}: ${err.message}`);
    }
    if (!isObj(raw)) throw new Error(`invalid feature-map root object in ${cand}`);

    const actionNames = [];
    if (Array.isArray(raw.actions)) {
      for (const a of raw.actions) {
        if (typeof a === 'string') actionNames.push(a);
        else if (isObj(a) && typeof a.name === 'string') actionNames.push(a.name);
      }
    }
    if (Array.isArray(raw.servers)) {
      for (const srv of raw.servers) {
        if (isObj(srv) && Array.isArray(srv.actions)) {
          for (const a of srv.actions) {
            if (isObj(a) && typeof a.name === 'string') actionNames.push(a.name);
          }
        }
      }
    }
    const panelIds = [];
    if (Array.isArray(raw.panels)) {
      for (const p of raw.panels) {
        if (typeof p === 'string') panelIds.push(p);
        else if (isObj(p)) panelIds.push(p.id ?? p.name);
      }
    }
    const states = sortedUnique(Array.isArray(raw.states) ? raw.states : []);
    const routes = Array.isArray(raw.routes)
      ? raw.routes
          .map((r) => (typeof r === 'string' ? { path: r } : isObj(r) && typeof r.path === 'string' ? r : null))
          .filter(Boolean)
      : [];

    const relPath = relative(resolve(root), absTarget).split('\\').join('/');
    return {
      found: true,
      path: relPath,
      actions: sortedUnique(actionNames),
      panels: sortedUnique(panelIds),
      states,
      routes,
      raw,
    };
  }
  return empty;
}

const NEW_MARKER = /\[new\]|\b(?:newly\s+(?:added|created|introduced)|new\s+(?:panel|action|surface)|(?:adds?|creates?|introduces?)\s+(?:a\s+|the\s+|an\s+)?(?:new\s+)?(?:panel|action|surface))\b/i;

/**
 * Extracts explicit `<ReinsPanel>` / `panel` IDs and `action` / `reins exec` names from a bar string.
 */
export function extractBarSurfaceRefs(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const markedNew = NEW_MARKER.test(text);
  const found = new Map();
  const patterns = [
    ['panel', new RegExp(`<ReinsPanel\\b[^>]*?\\bid\\s*=\\s*(?:"(${ID_PART})"|'(${ID_PART})'|(${ID_PART}))`, 'gi')],
    ['panel', new RegExp(`<ReinsPanel>\\s*(?:"(${ID_PART})"|'(${ID_PART})'|\`(${ID_PART})\`|(${ID_PART}))`, 'gi')],
    ['panel', new RegExp(`\\bpanel\\s*(?:[:=]\\s*(?:"(${ID_PART})"|'(${ID_PART})'|\`(${ID_PART})\`|(${ID_PART}))|(?:"(${ID_PART})"|'(${ID_PART})'|\`(${ID_PART})\`))`, 'gi')],
    ['action', new RegExp(`\\baction\\s*(?:[:=]\\s*(?:"(${ID_PART})"|'(${ID_PART})'|\`(${ID_PART})\`|(${ID_PART}))|(?:"(${ID_PART})"|'(${ID_PART})'|\`(${ID_PART})\`))`, 'gi')],
    ['action', new RegExp(`\\b(?:reins\\s+exec|reins_run_action)\\s+(?!reins_|--)(?:"(${ID_PART})"|'(${ID_PART})'|\`(${ID_PART})\`|(${ID_PART}))`, 'gi')],
  ];
  for (const [kind, re] of patterns) {
    for (const m of text.matchAll(re)) {
      const id = m.slice(1).find(Boolean);
      if (!id) continue;
      // Ignore HTML closing tag artifacts or generic flag prefixes
      if (id.startsWith('--') || id.startsWith('</')) continue;
      const key = `${kind}:${id}`;
      if (!found.has(key)) found.set(key, { kind, id, markedNew });
      else if (markedNew) found.get(key).markedNew = true;
    }
  }
  return [...found.values()];
}

/**
 * Validates unit `behaviours` (and optional unit `bar`) against a loaded `featureMap`.
 * Previously approved `status: 'new'` items in `priorContract` or `--new-surface` are allowed.
 */
export function validateBehavioursAgainstFeatureMap(
  behaviours,
  featureMap,
  { allowNew = false, bar = '', priorContract = [] } = {},
) {
  if (!featureMap?.found) return { ok: true, checked: false, errors: [], matched: [] };
  const knownPanels = new Set(featureMap.panels ?? []);
  const knownActions = new Set(featureMap.actions ?? []);
  const priorNew = new Set(
    (priorContract ?? [])
      .filter((c) => c && c.status === 'new' && c.kind && c.id)
      .map((c) => `${c.kind}:${c.id}`),
  );
  const unitWideNew = allowNew || (typeof bar === 'string' && NEW_MARKER.test(bar));

  const items = [
    ...(typeof bar === 'string' && bar.trim() ? [{ id: 'bar', text: bar }] : []),
    ...(behaviours ?? []).map((b, i) =>
      typeof b === 'string' ? { id: `B${i + 1}`, text: b } : { id: b?.id ?? `B${i + 1}`, text: b?.text ?? '' },
    ),
  ];

  const errors = [];
  const matched = [];
  const seenMatch = new Set();

  for (const item of items) {
    for (const ref of extractBarSurfaceRefs(item.text)) {
      const validSet = ref.kind === 'panel' ? knownPanels : knownActions;
      const isNew = unitWideNew || ref.markedNew || priorNew.has(`${ref.kind}:${ref.id}`);
      if (validSet.has(ref.id)) {
        const key = `${ref.kind}:${ref.id}:registered`;
        if (!seenMatch.has(key)) {
          seenMatch.add(key);
          matched.push({ kind: ref.kind, id: ref.id, behaviourId: item.id, status: 'registered' });
        }
      } else if (isNew) {
        const key = `${ref.kind}:${ref.id}:new`;
        if (!seenMatch.has(key)) {
          seenMatch.add(key);
          matched.push({ kind: ref.kind, id: ref.id, behaviourId: item.id, status: 'new' });
        }
      } else {
        errors.push({
          kind: ref.kind,
          id: ref.id,
          behaviourId: item.id,
          validActions: featureMap.actions ?? [],
          validPanels: featureMap.panels ?? [],
          message: `bar validation failed (${item.id}): unregistered ${ref.kind} "${ref.id}" not in ${featureMap.path} (valid panels: [${(featureMap.panels ?? []).join(', ') || 'none'}]; valid actions: [${(featureMap.actions ?? []).join(', ') || 'none'}]; mark newly introduced surfaces with [new] or --new-surface)`,
        });
      }
    }
  }

  return { ok: errors.length === 0, checked: true, errors, matched };
}
