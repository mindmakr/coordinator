// Makes run folders with each old release's own run.mjs, for skills/coordinator/scripts/test/fixtures/old-runs.
// usage: node tools/make-old-runs.mjs <oldRoot> <outRoot>, where <oldRoot>/0.N holds that release's scripts:
//   git archive <release commit> skills/coordinator/scripts | tar -x -C <oldRoot>/0.N
// Releases: 0.1 9c135fd, 0.2 878cead, 0.3 d8b56ed, 0.4 9322a3d, 0.5 fb3e0b9. Only state.json is kept.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [oldRoot, outRoot] = process.argv.slice(2);
for (const v of ['0.1', '0.2', '0.3', '0.4', '0.5']) {
  const dir = join(outRoot, `v${v}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const script = join(oldRoot, v, 'skills/coordinator/scripts/run.mjs');
  const env = { ...process.env, COORDINATOR_DIR: dir };
  const run = (...a) => { const r = spawnSync(process.execPath, [script, ...a], { env, encoding: 'utf8' }); if (r.status !== 0) console.error(v, a.slice(0, 3).join(' '), '->', (r.stderr || r.stdout).trim().slice(0, 160)); return r.status === 0; };
  const has = (n) => Number(v.slice(2)) >= n;

  // An open run: one unit passed after a failed round, one waiting, a question.
  const open = 'old-open';
  run('init', open, '--goal', 'Totals on the dashboard match the ledger', '--bar', 'The totals test passes', '--fence', 'src/dashboard only', '--tag', 'fixture');
  run('add', open, 'u1', '--bar', 'Server returns the ledger total', ...(has(4) ? ['--title', 'Server total'] : []));
  run('add', open, 'u2', '--bar', 'Card shows the server total', '--after', 'u1');
  if (has(5)) run('behave', open, 'u1', '--text', 'Given a ledger when totals load then they match');
  run('freeze', open); run('next', open);
  run('start', open, 'u1'); run('beat', open, 'u1'); run('built', open, 'u1');
  const b1 = has(5) ? ['--behaviour', 'B1=fail:off by one'] : [];
  run('verdict', open, 'u1', 'fail', '--evidence', 'test failed: 99 != 100', '--gap', 'rounding drops a cent', ...(has(2) ? ['--cause', 'rounding'] : []), '--score', '5', ...b1);
  run('next', open); run('start', open, 'u1'); run('built', open, 'u1');
  const b2 = has(5) ? ['--behaviour', 'B1=pass:test green'] : [];
  run('verdict', open, 'u1', 'pass', '--evidence', 'test passed', '--score', '9', ...b2);
  if (has(4)) run('ask', open, '--question', 'Round to the cent or to the riyal?', '--header', 'Rounding', '--option', 'Cent|Matches the ledger', '--option', 'Riyal|Matches the card design');
  else run('note', open, '--kind', 'question', '--text', 'Round to the cent or to the riyal?', ...(has(3) ? ['--recommend', 'cent'] : []));
  run('note', open, '--kind', 'decision', '--text', 'Use the server total', ...(has(4) || !has(3) ? [] : ['--answers', 'q1']));
  run('next', open);

  // A closed run.
  const closed = 'old-closed';
  run('init', closed, '--goal', 'Fix the export header', '--bar', 'Header test passes', '--fence', 'src/export', '--tag', 'fixture');
  run('add', closed, 'u1', '--bar', 'Header has the date');
  run('freeze', closed); run('next', closed);
  run('start', closed, 'u1'); run('built', closed, 'u1');
  run('verdict', closed, 'u1', 'pass', '--evidence', 'header test passed', '--score', '10');
  run('next', closed); run('integrate', closed, 'pass', '--evidence', 'all checks green');
  run('note', closed, '--kind', 'follow-up', '--text', 'Export CSV has the same header');
  run('close', closed, '--outcome', 'done');
}
