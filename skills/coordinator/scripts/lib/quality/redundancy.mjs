// Redundancy, from the run's project map (lib/map) when it has one: code
// files nothing imports (dead-file candidates) and functions with the same
// shape in several places (the map's reuse groups). Entry points (pages,
// routes, scripts, configs, tests, migrations, index files) are never dead.
// The map does not record which exports are used, so unused exports are not
// measured. Without a map: nothing, and the report says how to build one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { files as mapFiles, load } from '../map/log.mjs';
import { TEST } from './source.mjs';

const ENTRY = /(^|\/)(index|main|server|app|cli|page|layout|route|loading|error|not-found|middleware|instrumentation|config|setup|seed)\.[cm]?[jt]sx?$|(^|\/)(scripts?|bin|migrations?|drizzle|e2e|public|\.storybook)\/|\.(config|setup|d|stories)\.[cm]?[jt]sx?$|(^|\/)(app|pages)\//;

export function loadMap(runDir) {
  const dir = join(runDir, 'map');
  if (!runDir || !existsSync(mapFiles(dir).events)) return null;
  try { return load(dir, { write: false }); } catch { return null; }
}

export function redundancy(map, { focus = null } = {}) {
  if (!map) return { measured: false, why: 'no project map for this run: run.mjs map <run>, then quality again' };
  const imported = new Set(map.modules.flatMap((m) => m.imports ?? []));
  const surfaces = new Set(map.surfaces.map((s) => s.file).filter(Boolean));
  const dead = map.modules.filter((m) => /^(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(m.lang) && !imported.has(m.id) && !surfaces.has(m.id) && !TEST.test(m.id) && !ENTRY.test(m.id) && (!focus || focus.has(m.id)));
  const reuse = map.reuse.filter((r) => !focus || r.fns.some((fn) => focus.has(fn.split('#')[0])));
  return {
    measured: true, partial: !!map.meta?.partial,
    deadFiles: { count: dead.length, top: dead.slice(0, 15).map((m) => ({ file: m.id, line: 1, text: `${m.lines ?? '?'} lines, imported by no file` })) },
    reuse: { count: reuse.length, top: reuse.slice(0, 10).map((r) => ({ file: r.fns[0].split('#')[0], line: Number(r.fns[0].split(':').at(-1)) || 1, text: `${r.lines} lines, same shape in ${r.fns.length} places: ${r.fns.slice(0, 4).join(', ')}` })) },
    unusedExports: { measured: false, why: 'the map records shared helpers, not every export' },
  };
}
