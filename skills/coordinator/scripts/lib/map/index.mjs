// The map commands behind run.mjs: build and record a map in the run's folder
// (map/events.jsonl, map/map.json, map/map.md, and map.html beside hud.html),
// stage it at a pit stop, and answer "what does this file touch".
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { esc } from '../links.mjs';
import { page } from '../parts.mjs';
import { writeAtomic } from '../store.mjs';
import { buildMap } from './build.mjs';
import { files, load, record } from './log.mjs';
import { mapPage } from './page.mjs';
import { summary } from './summary.mjs';
import { text, touches } from './touches.mjs';

export const mapDir = (runDir) => join(runDir, 'map');
export const mapHtml = (runDir) => join(runDir, 'map.html');
export const hasMap = (runDir) => existsSync(files(mapDir(runDir)).events);

// What a pit stop ships: the log and the summary. map.json is rebuilt from the log on read.
export const PIT_STOP = ['events.jsonl', 'map.md'];
// Without --dest a pit stop stages them in the run's own state folder; nothing is written to the project's tree.
export const defaultDest = (runDir) => join(runDir, 'pit-stop', 'map');

// For the state branch (c10's `run.mjs push`, lib/statesync.mjs): the files to add
// under the run, as { 'runs/<run>/map/<name>': content }.
// TODO(c10): once statesync.mjs is merged, spread pitStopFiles(o.dir, runId) into
// the map its files() returns, masked with the same redactor, so `push` carries the map.
export function pitStopFiles(runDir, run) {
  if (!hasMap(runDir)) return {};
  return Object.fromEntries(PIT_STOP.map((n) => [`runs/${run}/map/${n}`, readFileSync(join(mapDir(runDir), n))]));
}

// A broken log is named, with the way out.
const recover = (run, e) => new Error(`${e.message}. To start the map over: run.mjs map ${run} --fresh (the old map/ folder is kept beside it)`);
function loadMap(run, runDir) {
  try { return load(mapDir(runDir)); } catch (e) { throw recover(run, e); }
}

// --fresh moves the old map aside (map.old-<time>) and starts a new log.
// A partial build (stopped at the time cap) over a full map is refused unless --force:
// recorded, it would replace full records with thinner ones.
export function build(run, runDir, { root, maxSeconds, unit = null, ctx, fresh = false, force = false, now }) {
  if (fresh && existsSync(mapDir(runDir))) renameSync(mapDir(runDir), `${mapDir(runDir)}.old-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const built = buildMap(root, { maxSeconds, ...(now ? { now } : {}) });
  if (built.meta.partial && !force && hasMap(runDir)) {
    const prev = loadMap(run, runDir).build;
    if (prev && !prev.partial) throw new Error(`map not recorded: this build stopped at the ${maxSeconds} s cap after ${built.meta.scanned} files, and build ${prev.n} is complete. Raise --max-seconds, or pass --force to record it (a partial build adds and updates records, never removes them)`);
  }
  let snap;
  try { snap = record(mapDir(runDir), built, { unit }); } catch (e) { throw recover(run, e); }
  writeAtomic(join(mapDir(runDir), 'map.md'), summary(snap, run));
  writeAtomic(mapHtml(runDir), mapPage(snap, ctx, run));
  return snap;
}

// Pit stop: the log and summary go to `dest` (default: staged in the run's folder).
// Refuses when the destination's log has lines this run's log lacks: it was written elsewhere.
export function pitStop(runDir, dest) {
  const src = mapDir(runDir);
  if (!hasMap(runDir)) throw new Error('no map yet: run map first');
  const out = resolve(dest);
  mkdirSync(out, { recursive: true });
  const mine = readFileSync(files(src).events, 'utf8');
  const theirs = existsSync(join(out, 'events.jsonl')) ? readFileSync(join(out, 'events.jsonl'), 'utf8') : '';
  if (!mine.startsWith(theirs)) throw new Error(`pit stop refused: ${join(out, 'events.jsonl')} has events this run's log lacks (written from another machine?); merge it first or pick another --dest`);
  for (const name of PIT_STOP) writeAtomic(join(out, name), readFileSync(join(src, name)));
  return { dest: out, files: PIT_STOP };
}

// The map page, live or static. A broken log renders a page that says what broke and how to recover.
export function mapView(run, runDir, ctx) {
  try { return mapPage(loadMap(run, runDir), ctx, run); } catch (e) {
    const body = `<a class="back" href="${esc(ctx.home)}">← ${esc(run)} dashboard</a><header class="run"><h1>Project map · not readable</h1></header>`
      + `<div class="needs"><p><b>The map's log could not be read.</b></p><p>${esc(e.message)}</p></div>`;
    return page({ title: `Map · ${run}`, body, ctx, path: `${ctx.base ?? ''}/map` });
  }
}

export function touchesOf(run, runDir, path, json = false) {
  if (!hasMap(runDir)) throw new Error('no map yet: run map first');
  const t = touches(loadMap(run, runDir), path);
  if (!t) throw new Error(`not in the map: ${path} (paths are relative to the mapped root)`);
  return json ? t : text(t);
}
