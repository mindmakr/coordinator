// The map commands behind run.mjs: build and record a map in the run's folder
// (map/events.jsonl, map/map.json, map/map.md, and map.html beside hud.html),
// stage it at a pit stop, and answer "what does this file touch".
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { esc } from '../links.mjs';
import { page } from '../parts.mjs';
import { withLock, writeAtomic } from '../store.mjs';
import { buildMap } from './build.mjs';
import { callsText, unitCalls } from './calls.mjs';
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

// The state branch (`run.mjs push`/`pull`, lib/statesync.mjs) carries the staged pit stop
// as runs/<run>/map/events.jsonl and map.md. The map keeps its own files and its own lock
// (map/events.jsonl.lock), apart from the run's events.jsonl and state.json.
const copyPath = (run, name) => `runs/${run}/map/${name}`;
const sha = (x) => createHash('sha256').update(x).digest('hex');
// The hash a log's opening map.reset line replaces, or null.
const resetOf = (log) => { try { const e = JSON.parse(String(log).slice(0, String(log).indexOf('\n'))); return e.kind === 'map.reset' ? e.replaces : null; } catch { return null; } };

// push's attach hook: the staged files, masked line by line with push's redactor; refused,
// like the run's own log, when the copy has map events the staged log lacks.
export const mapAttach = (runDir) => ({ run, red, read }) => {
  const stage = defaultDest(runDir);
  if (!existsSync(join(stage, 'events.jsonl'))) return {}; // no pit stop yet
  const log = readFileSync(join(stage, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => `${JSON.stringify(red(JSON.parse(l)))}\n`).join('');
  const theirs = read(copyPath(run, 'events.jsonl'));
  if (theirs && !log.startsWith(theirs.toString('utf8')) && resetOf(log) !== sha(theirs)) {
    throw new Error(`refused: the copy of ${run}'s project map has events this pit stop lacks (written from another machine); run.mjs pull ${run} first, or start the map over with run.mjs map ${run} --reset-stage after pulling; nothing pushed`);
  }
  const out = { [copyPath(run, 'events.jsonl')]: log };
  if (existsSync(join(stage, 'map.md'))) out[copyPath(run, 'map.md')] = red(readFileSync(join(stage, 'map.md'), 'utf8'));
  return out;
};

// pull's restore hook: the copy's map log becomes the local one when there is none, or
// fast-forwards it; a local log ahead of the copy is kept; one that differs is kept and named.
export const mapRestore = (runDir) => ({ run, read }) => {
  const theirs = read(copyPath(run, 'events.jsonl'));
  if (!theirs) return 'none';
  const copy = theirs.toString('utf8');
  const local = files(mapDir(runDir)).events;
  return withLock(local, () => {
    const mine = existsSync(local) ? readFileSync(local, 'utf8') : '';
    if (mine.startsWith(copy)) return mine.length === copy.length ? 'up-to-date' : 'local-ahead';
    // A reset replaces the history this machine holds (its log or its stage): the old one moves aside.
    const stage = join(defaultDest(runDir), 'events.jsonl');
    const reset = !copy.startsWith(mine) && resetOf(copy) && [mine, existsSync(stage) ? readFileSync(stage, 'utf8') : null].some((x) => x && sha(x) === resetOf(copy));
    if (!copy.startsWith(mine) && !reset) {
      // The stage now mirrors the copy, so `--reset-stage` names exactly the history it replaces.
      writeAtomic(stage, copy);
      return `kept the local map: it and the copy differ; run.mjs map ${run} --reset-stage replaces the copy with a new history, or move map/ aside and pull to take the copy`;
    }
    if (reset) renameSync(mapDir(runDir), `${mapDir(runDir)}.old-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(mapDir(runDir), { recursive: true });
    writeAtomic(local, copy); // map.json catches up on the next read
    const md = read(copyPath(run, 'map.md'));
    if (md) writeAtomic(join(mapDir(runDir), 'map.md'), md);
    for (const [name, content] of [['events.jsonl', copy], ['map.md', md]]) if (content) writeAtomic(join(defaultDest(runDir), name), content);
    return reset ? 'reset' : mine ? 'fast-forward' : 'restored';
  });
};

// A broken log is named, with the way out.
const recover = (run, e) => new Error(`${e.message}. To start the map over: run.mjs map ${run} --fresh (the old map/ folder is kept beside it), or --reset-stage if this map was staged or pushed`);
function loadMap(run, runDir) {
  try { return load(mapDir(runDir)); } catch (e) { throw recover(run, e); }
}

// --fresh moves the old map aside (map.old-<time>) and starts a new log.
// A partial build (stopped at the time cap) over a full map is refused unless --force:
// recorded, it would replace full records with thinner ones.
//
// --reset-stage (implies --fresh) is the sanctioned new history: the old map and the staged
// pit stop move aside, the new log opens with map.reset naming the SHA-256 of the staged log
// it replaces, and the new map is staged at once. push accepts it over a copy with that hash;
// pull accepts it over a local log or stage with that hash.
export function build(run, runDir, { root, maxSeconds, unit = null, ctx, fresh = false, force = false, resetStage = false, now }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stage = join(defaultDest(runDir), 'events.jsonl');
  const replaces = resetStage && existsSync(stage) ? sha(readFileSync(stage)) : '';
  if ((fresh || resetStage) && existsSync(mapDir(runDir))) renameSync(mapDir(runDir), `${mapDir(runDir)}.old-${stamp}`);
  if (resetStage && existsSync(defaultDest(runDir))) renameSync(defaultDest(runDir), `${defaultDest(runDir)}.old-${stamp}`);
  const built = buildMap(root, { maxSeconds, ...(now ? { now } : {}) });
  const prev = built.meta.partial && hasMap(runDir) ? loadMap(run, runDir).build : null;
  if (prev && !prev.partial) {
    if (!force) throw new Error(`map not recorded: this build stopped at the ${maxSeconds} s cap after ${built.meta.scanned} files, and build ${prev.n} is complete. Raise --max-seconds, or pass --force to record it (a partial build adds and updates records, never removes them)`);
    // Message usage counted over part of the code would overstate unused keys: keep the complete build's figures.
    built.meta.messages = { ...prev.messages, catalogs: built.meta.messages.catalogs, from: `build ${prev.n} (this build is partial)` };
  }
  let snap;
  try { snap = record(mapDir(runDir), built, { unit, ...(resetStage ? { reset: replaces } : {}) }); } catch (e) { throw recover(run, e); }
  writeAtomic(join(mapDir(runDir), 'map.md'), summary(snap, run));
  writeAtomic(mapHtml(runDir), mapPage(snap, ctx, run));
  if (resetStage) pitStop(runDir, defaultDest(runDir)); // staged at once: the reset is meant to be pushed
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

// The header nav on a run's map page (live): that run's dashboard, its run maps and its
// project map, then the coordinator's page. On /run/<other>/map it names <other>, not the served run.
export function mapNav(ctx, id) {
  const base = ctx.base ?? '';
  return [
    { path: base || '/', label: id, href: ctx.home },
    { path: `${base}/maps`, label: 'Maps', href: ctx.maps },
    { path: `${base}/map`, label: 'Project map', href: ctx.mapHref },
    ...(ctx.pages ?? []).filter((p) => p.path === '/coordinator'),
  ];
}

// The map page, live or static. A broken log renders a page that says what broke and how to recover.
export function mapView(run, runDir, ctx) {
  try { return mapPage(loadMap(run, runDir), ctx, run); } catch (e) {
    const body = `<a class="back" href="${esc(ctx.home)}">← ${esc(run)} dashboard</a><header class="run"><h1>Project map · not readable</h1></header>`
      + `<div class="needs"><p><b>The map's log could not be read.</b></p><p>${esc(e.message)}</p></div>`;
    return page({ title: `Map · ${run}`, body, ctx, path: `${ctx.base ?? ''}/map` });
  }
}

// Function calls per unit (lib/map/calls.mjs): map/calls/<unit>.json, and the scan cache
// map/calls-cache.json keyed by file hash. Both are local and derived: a pit stop ships neither.
const callsFile = (runDir, unit) => join(mapDir(runDir), 'calls', `${unit}.json`);
export function computeCalls(runDir, opts) {
  const data = unitCalls(opts.root, { ...opts, cacheFile: join(mapDir(runDir), 'calls-cache.json') });
  mkdirSync(join(mapDir(runDir), 'calls'), { recursive: true });
  writeAtomic(callsFile(runDir, opts.unit), `${JSON.stringify(data)}\n`);
  return data;
}
export { callsText };

// The files a map build tagged with this unit changed (modules set or removed): the fallback when no diff is recorded.
export function unitFiles(runDir, unit) {
  const f = files(mapDir(runDir)).events;
  if (!existsSync(f)) return [];
  const events = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const n = events.filter((e) => e.kind === 'map.build' && e.unit === unit).at(-1)?.build;
  if (n === undefined || n === events.find((e) => e.kind === 'map.build')?.build) return []; // a first build has no baseline: every file is new to it
  return [...new Set(events.filter((e) => e.kind === 'map.delta' && e.build === n && e.coll === 'modules').flatMap((e) => [...e.set.map((r) => r.id), ...e.del]))].sort();
}

// What the pages read: one unit's data, or every unit's, read once per render.
export function readCalls(runDir) {
  const memo = new Map();
  const get = (unit) => {
    if (!memo.has(unit)) { let d = null; try { d = JSON.parse(readFileSync(callsFile(runDir, unit), 'utf8')); } catch { /* none yet */ } memo.set(unit, d?.v === 1 ? d : null); }
    return memo.get(unit);
  };
  const list = () => {
    let names = [];
    try { names = readdirSync(join(mapDir(runDir), 'calls')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort(); } catch { /* none */ }
    return names.map((unit) => ({ unit, data: get(unit) })).filter((x) => x.data);
  };
  return { get, list };
}

export function touchesOf(run, runDir, path, json = false) {
  if (!hasMap(runDir)) throw new Error('no map yet: run map first');
  const t = touches(loadMap(run, runDir), path);
  if (!t) throw new Error(`not in the map: ${path} (paths are relative to the mapped root)`);
  return json ? t : text(t);
}
