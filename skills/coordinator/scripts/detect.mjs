#!/usr/bin/env node
// Flags a diff that games the bar: focused, skipped, deleted or renamed-away
// tests, removed, weakened or trivialized assertions, tests excluded in runner
// config, rewritten snapshots, suppressed checks, ignored failures, and files
// outside the fence. Exit 0 = clean, 1 = hits (a FAIL), 2 = usage.
//
//   detect.mjs --base <ref> [--head <ref>] [--run <run> [--unit <unit>]] [--fence a,b] [--allow rule[:path],…]
// --allow may be given more than once (--allow a:x --allow b:y), or as one comma list.
//   detect.mjs --diff-file <file> [same options]
// --run adds the fence paths recorded on the run (run.mjs init --paths).
// --unit records the result on that unit; on a run with --paths, a PASS verdict needs it clean.
// On a pass waiting for its fold-in check, --base <reviewed head> --head <fold head> checks the fold (run.mjs foldin needs it clean).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpAndExit, parse } from './lib/args.mjs';
import { allowed, detect, parseDiff } from './lib/gaming.mjs';
import { EVENTS, loadRun, updateRun } from './lib/events.mjs';
import { baseDir, safeId } from './lib/store.mjs';
import { harnessOf, stamp } from './lib/harness.mjs';

// A comma list, or several of them (a repeated --allow).
const list = (v) => [v].flat().filter((x) => typeof x === 'string').flatMap((x) => x.split(',')).map((s) => s.trim()).filter(Boolean);
const PATHS_MAX = 300;
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

// A ref must be a real commit; a leading '-' would be read as a git option.
function commit(ref, name) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /\s/.test(ref)) throw new Error(`bad --${name}: ${ref}`);
  return git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim();
}

helpAndExit(import.meta.url);
try {
  const { opt } = parse(process.argv.slice(2), ['base', 'head', 'run', 'unit', 'fence', 'allow', 'diff-file'], ['allow']);
  if (opt.unit && !opt.run) throw new Error('--unit needs --run');
  const dir = opt.run ? join(baseDir('project'), 'runs', safeId(opt.run, 'run')) : null;
  if (dir && !existsSync(join(dir, 'state.json')) && !existsSync(join(dir, EVENTS))) throw new Error(`no run: ${opt.run}`);
  const fence = list(opt.fence).concat(dir ? loadRun(dir).paths ?? [] : []);
  let diff; let base = null; let head = null;
  if (opt['diff-file']) diff = readFileSync(opt['diff-file'], 'utf8');
  else {
    if (!opt.base) throw new Error('need --base <ref> or --diff-file <file>');
    if (opt.unit && !opt.head) throw new Error('--unit needs an explicit --head (the PR head the critic will judge)');
    base = commit(opt.base, 'base');
    head = commit(opt.head ?? 'HEAD', 'head');
    diff = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--unified=0', '-M', `${base}...${head}`]);
  }
  const changed = parseDiff(diff);
  const files = changed.length;
  const allow = list(opt.allow);
  const hits = detect(diff, { fence }).filter((h) => !allowed(h, allow));
  let result = { allow, hits };
  if (opt.unit) {
    // An empty diff proves nothing: it would let a PASS through unchecked.
    if (!files) throw new Error('empty diff: nothing was checked (is --head the builder\'s commit?)');
    updateRun(dir, { kind: 'unit.detect', unit: safeId(opt.unit, 'unit'), by: stamp(harnessOf(undefined)) }, (s) => {
      if (s.closed) throw new Error(`run ${opt.run} is closed`);
      const u = s.units.find((x) => x.id === safeId(opt.unit, 'unit'));
      if (!u) throw new Error(`no unit ${opt.unit} in run ${opt.run}`);
      // While judging, or on a pass whose fold-ins wait for their check (run.mjs foldin).
      const last = u.rounds.at(-1);
      const fold = u.status === 'pass' && last?.folds?.length > 0 && !last.foldin;
      if (u.status !== 'judging' && !fold) throw new Error(`unit ${opt.unit} is ${u.status}; detect is recorded while judging, or on a pass waiting for its fold-in check`);
      // The paths it changed (renames by both names): `next` compares them across units (lib/overlap.mjs).
      const paths = [...new Set(changed.flatMap((f) => [f.path, f.renamedFrom].filter(Boolean)))].sort().slice(0, PATHS_MAX);
      const round = fold ? u.rounds.length : u.rounds.length + 1;
      // A rerun without --allow on the same round, base and head (the critic's) keeps the lead's allowances (#45).
      const same = u.detect && u.detect.round === round && u.detect.base === base && u.detect.head === head && !!u.detect.fold === fold;
      const kept = opt.allow === undefined && same ? (u.detect.allow ?? []) : allow;
      const left = kept === allow ? hits : detect(diff, { fence }).filter((h) => !allowed(h, kept));
      result = { allow: kept, hits: left };
      u.detect = { round, clean: left.length === 0, base, head, files, paths, allow: kept, hits: left.length, at: new Date().toISOString(), ...(fold ? { fold: true } : {}) };
    });
  }
  console.log(JSON.stringify({ clean: result.hits.length === 0, base, head, files, fence, allowed: result.allow, hits: result.hits }, null, 2));
  process.exit(result.hits.length ? 1 : 0);
} catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
