// The map commands behind run.mjs: build and record a map in the run's folder
// (map/events.jsonl, map/map.json, map/map.md, and map.html beside hud.html),
// copy it into the repo at a pit stop, and answer "what does this file touch".
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomic } from '../store.mjs';
import { buildMap } from './build.mjs';
import { files, load, record } from './log.mjs';
import { mapPage } from './page.mjs';
import { summary } from './summary.mjs';
import { text, touches } from './touches.mjs';

export const mapDir = (runDir) => join(runDir, 'map');
export const mapHtml = (runDir) => join(runDir, 'map.html');
export const hasMap = (runDir) => existsSync(files(mapDir(runDir)).events);

// The run's own repo copy: under the mapped root, laid out like the state branch (runs/<run>/map).
export const defaultDest = (root, run) => join(root, 'coordinator', 'runs', run, 'map');

export function build(run, runDir, { root, maxSeconds, unit = null, ctx }) {
  const built = buildMap(root, { maxSeconds });
  const snap = record(mapDir(runDir), built, { unit });
  writeAtomic(join(mapDir(runDir), 'map.md'), summary(snap, run));
  writeAtomic(mapHtml(runDir), mapPage(snap, ctx, run));
  return snap;
}

// Pit stop: the log, snapshot and summary go into the repo's working tree (the lead commits them).
// Refuses when the repo's log has lines this machine's log lacks: it was written elsewhere.
export function pitStop(runDir, dest) {
  const src = mapDir(runDir);
  if (!hasMap(runDir)) throw new Error('no map yet: run map first');
  const out = resolve(dest);
  mkdirSync(out, { recursive: true });
  const mine = readFileSync(files(src).events, 'utf8');
  const theirs = existsSync(join(out, 'events.jsonl')) ? readFileSync(join(out, 'events.jsonl'), 'utf8') : '';
  if (!mine.startsWith(theirs)) throw new Error(`pit stop refused: ${join(out, 'events.jsonl')} has events this run's log lacks (written from another machine?); merge it first or pick another --dest`);
  for (const name of ['events.jsonl', 'map.json', 'map.md']) writeAtomic(join(out, name), readFileSync(join(src, name)));
  return { dest: out, files: ['events.jsonl', 'map.json', 'map.md'] };
}

export function rerender(run, runDir, ctx) {
  const snap = load(mapDir(runDir));
  return mapPage(snap, ctx, run);
}

export function touchesOf(runDir, path, json = false) {
  if (!hasMap(runDir)) throw new Error('no map yet: run map first');
  const t = touches(load(mapDir(runDir)), path);
  if (!t) throw new Error(`not in the map: ${path} (paths are relative to the mapped root)`);
  return json ? t : text(t);
}
