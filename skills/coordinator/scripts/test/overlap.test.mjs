// Parallel units that change the same files (#37): once one merges, `next`
// tells the lead to merge the target into the others before their review.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pendingSyncs, syncStep, unitPaths } from '../lib/overlap.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-overlap-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const cli = (script, ...args) => {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
  let out = r.stdout; try { out = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out, err: r.stderr };
};
const run = (...a) => cli('run.mjs', ...a);
const state = (id) => JSON.parse(readFileSync(join(dir, 'runs', id, 'state.json'), 'utf8'));

const T1 = '2026-11-07T10:00:00.000Z'; const T2 = '2026-11-07T11:00:00.000Z';
const merged = (at) => [{ kind: 'merge', url: 'https://github.com/o/r/pull/1', at }];

test('a unit\'s files: planned with touches, and from its last checked diff', () => {
  assert.deepEqual([...unitPaths({ touches: ['./content/en.json'], detect: { paths: ['content\\ar.json', 'content/en.json'] } })], ['content/en.json', 'content/ar.json']);
  assert.equal(unitPaths({}).size, 0, 'old units without either load');
});

test('only a merged unit that shares a file, merged after the last sync, asks for one', () => {
  const units = [
    { id: 'u1', status: 'pass', touches: ['content/en.json', 'content/ar.json', 'a.js'], links: merged(T1) },
    { id: 'u2', status: 'judging', detect: { paths: ['content/en.json', 'content/ar.json', 'b.js'] } },
    { id: 'u3', status: 'open', touches: ['c.js'] },
    { id: 'u4', status: 'pass', touches: ['content/en.json'], links: merged(T2) },
    { id: 'u5', status: 'judging', touches: ['content/en.json'], syncedAt: T2 },
    { id: 'u6', status: 'stopped', touches: ['content/en.json'] },
  ];
  const p = pendingSyncs({ units });
  assert.deepEqual([...p.keys()], ['u2']);
  assert.deepEqual(p.get('u2'), [{ unit: 'u1', at: T1, paths: ['content/ar.json', 'content/en.json'] }, { unit: 'u4', at: T2, paths: ['content/en.json'] }]);
  const synced = pendingSyncs({ units: units.map((u) => (u.id === 'u2' ? { ...u, syncedAt: '2026-11-07T10:30:00.000Z' } : u)) });
  assert.deepEqual(synced.get('u2').map((x) => x.unit), ['u4'], 'a sync covers merges before it only');
  assert.equal(syncStep('r', 'u2', p.get('u2')), 'u2 overlaps u1 in content/ar.json, content/en.json; u4 in content/en.json, merged already: merge the target into u2 before review, then run.mjs sync r u2');
  assert.match(syncStep('r', 'u2', [{ unit: 'u1', paths: ['a', 'b', 'c', 'd', 'e', 'f'] }], true), /in a, b, c, d and 2 more, merged already: merge the target into u2 before merging/);
});

test('next names the step once an overlapping unit merged; sync clears it; detect records the paths', () => {
  run('init', 'p', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  for (const u of ['u1', 'u3']) run('add', 'p', u, '--bar', 'b');
  run('freeze', 'p');
  assert.equal(run('touches', 'p', 'content/en.json', '--unit', 'u1').out.recorded, 'content/en.json', 'recorded without a map');
  assert.match(run('touches', 'p', '../x', '--unit', 'u1').err, /relative to the project root/);
  run('touches', 'p', 'content/en.json', '--unit', 'u3');
  run('touches', 'p', 'content/en.json', '--unit', 'u3');
  assert.deepEqual(state('p').units[1].touches, ['content/en.json'], 'once');
  for (const u of ['u1', 'u3']) { run('start', 'p', u); run('built', 'p', u); }
  const diff = join(dir, 'u3.diff');
  writeFileSync(diff, 'diff --git a/content/ar.json b/content/ar.json\n--- a/content/ar.json\n+++ b/content/ar.json\n@@ -1 +1 @@\n-{}\n+{"a":1}\n');
  assert.equal(cli('detect.mjs', '--diff-file', diff, '--run', 'p', '--unit', 'u3').code, 0);
  assert.deepEqual(state('p').units[1].detect.paths, ['content/ar.json']);
  run('verdict', 'p', 'u1', 'pass', '--evidence', 'green', '--score', '9');
  assert.equal(run('next', 'p').out.units[1].sync, undefined, 'nothing merged yet');
  run('link', 'p', 'u1', '--merge', 'https://github.com/o/r/pull/7');
  const u3 = run('next', 'p').out.units[1];
  assert.equal(u3.action, 'judge');
  assert.equal(u3.sync, 'u3 overlaps u1 in content/en.json, merged already: merge the target into u3 before review, then run.mjs sync p u3');
  assert.match(run('show', 'p').out, /⇄ u3 overlaps u1 in content\/en\.json/);
  assert.equal(run('sync', 'p', 'u3', '--text', 'merged main at abc123').code, 0);
  assert.equal(run('next', 'p').out.units[1].sync, undefined);
  assert.equal(state('p').units[1].log.at(-1).kind, 'sync');
});
