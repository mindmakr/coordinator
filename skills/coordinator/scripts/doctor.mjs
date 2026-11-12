#!/usr/bin/env node
// Checks that this machine and project are set up for the coordinator, one line
// per item with ok, warn, FAIL or skip and a one-line fix. Never prints tokens.
//
//   doctor.mjs [--json] [--offline]   exit 1 when any check fails
//   --offline skips the checks that reach GitHub (gh login, stateRepo, latest release)
import { homedir } from 'node:os';
import { helpAndExit, parse } from './lib/args.mjs';
import { diagnose, format } from './lib/doctor.mjs';
import { baseDir, projectDir } from './lib/store.mjs';
import { VERSION } from './lib/version.mjs';

helpAndExit(import.meta.url);
try {
  const { pos, opt } = parse(process.argv.slice(2), ['json', 'offline']);
  if (pos.length) throw new Error(`unexpected argument: ${pos[0]}`);
  const results = diagnose({
    project: projectDir(), base: baseDir('project'), globalBase: baseDir('global'), home: homedir(),
    version: VERSION, online: opt.offline === undefined && !process.env.COORDINATOR_OFFLINE,
  });
  console.log(opt.json ? JSON.stringify({ version: VERSION, ok: !results.some((r) => r.status === 'fail'), checks: results }, null, 2) : format(results));
  process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
