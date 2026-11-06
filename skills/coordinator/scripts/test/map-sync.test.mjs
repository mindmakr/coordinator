import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The project map rides the run's pit stop to the coordinator-state branch:
// two machines (clones a and b) share a bare repo, each with its own state folder.
const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..');
const root = mkdtempSync(join(tmpdir(), 'coordinator-mapsync-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const origin = join(root, 'origin.git');
const A = join(root, 'a'); const B = join(root, 'b');
mkdirSync(A);
git(A, 'init', '-q', '-b', 'main'); writeFileSync(join(A, 'README.md'), 'code\n'); git(A, 'add', '.'); git(A, 'commit', '-qm', 'code');
git(root, 'clone', '-q', '--bare', A, origin);
git(A, 'remote', 'add', 'origin', origin); git(A, 'fetch', '-q', 'origin'); git(A, 'remote', 'set-head', 'origin', 'main');
git(root, 'clone', '-q', origin, B);

// The mapped code: the fixture, with a token pasted into a message catalog.
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const code = join(root, 'code');
cpSync(join(here, 'fixtures', 'map-project'), code, { recursive: true });
writeFileSync(join(code, 'messages', 'en.json'), JSON.stringify({ employer: { title: 'Employer', subtitle: 'Settings', unused: 'x', [SECRET]: 'leaked' } }));

const stateDir = (m) => join(root, `${m === A ? 'a' : 'b'}-state`);
for (const m of [A, B]) { mkdirSync(stateDir(m), { recursive: true }); writeFileSync(join(stateDir(m), 'coordinator.json'), JSON.stringify({ visibility: 'private' })); }
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const cli = (m, ...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { cwd: m, env: { ...process.env, COORDINATOR_DIR: stateDir(m) }, encoding: 'utf8' }); return { code: r.status, out: json(r.stdout), err: r.stderr }; };
const show = (path) => git(origin, 'show', `coordinator-state:${path}`);

test('push carries the staged map with the run, masked; nothing before a pit stop', () => {
  assert.equal(cli(A, 'init', 'r1', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 0);
  assert.equal(cli(A, 'map', 'r1', '--root', code).code, 0);
  const before = cli(A, 'push', 'r1');
  assert.equal(before.code, 0, before.err);
  assert.ok(!before.out.files.some((f) => f.includes('/map/')), 'a map with no pit stop stays local');
  const r = cli(A, 'map', 'r1', '--root', code, '--pit-stop');
  assert.equal(r.code, 0, r.err);
  const p = cli(A, 'push', 'r1', '--message', 'pit stop: map');
  assert.equal(p.code, 0, p.err);
  assert.ok(p.out.files.includes('runs/r1/map/events.jsonl') && p.out.files.includes('runs/r1/map/map.md'));
  assert.ok(!p.out.files.includes('runs/r1/map/map.json'), 'the snapshot is rebuilt from the log');
  const log = show('runs/r1/map/events.jsonl');
  assert.equal(log.includes(SECRET), false, 'no secret on the branch');
  assert.match(log, /\[redacted\]/);
  assert.equal(log, readFileSync(join(stateDir(A), 'runs', 'r1', 'pit-stop', 'map', 'events.jsonl'), 'utf8'), 'masked when recorded, so push changes nothing');
  assert.equal(readFileSync(join(stateDir(A), 'runs', 'r1', 'map', 'events.jsonl'), 'utf8').includes(SECRET), false, 'not even locally');
});

test('pull restores the map on another machine, and it reads cleanly there', () => {
  const r = cli(B, 'pull', 'r1');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'restored'); assert.equal(r.out.map, 'restored');
  const t = cli(B, 'touches', 'r1', 'src/routes/employer.ts');
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /Uses shared helpers: changeEmployerSettings/);
  assert.equal(cli(B, 'pull', 'r1').out.map, 'up-to-date');
});

test('the map log only moves forward: a pit stop from another machine is refused until pulled', () => {
  // b builds and pushes first; a, with a different build of its own, is refused.
  assert.equal(cli(B, 'map', 'r1', '--root', code, '--pit-stop').code, 0);
  const pb = cli(B, 'push', 'r1');
  assert.equal(pb.code, 0, pb.err);
  writeFileSync(join(code, 'src', 'extra.ts'), 'export const x = 1;\n');
  assert.equal(cli(A, 'map', 'r1', '--root', code, '--pit-stop').code, 0);
  const tip = git(origin, 'rev-parse', 'coordinator-state').trim();
  const refused = cli(A, 'push', 'r1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /project map has events this pit stop lacks.*pull r1 first; nothing pushed/);
  assert.equal(git(origin, 'rev-parse', 'coordinator-state').trim(), tip, 'nothing pushed');
  const pulled = cli(A, 'pull', 'r1');
  assert.equal(pulled.code, 0, pulled.err);
  assert.match(pulled.out.map, /kept the local map.*--fresh/, 'a different local map is kept, and named');
  assert.ok(existsSync(join(stateDir(A), 'runs', 'r1', 'map', 'map.json')));
});

test('the map has its own files and lock, apart from the run\'s event log', () => {
  const dir = join(stateDir(A), 'runs', 'r1');
  const runLog = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.equal(cli(A, 'map', 'r1', '--root', code).code, 0);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), runLog, 'a map build adds nothing to the run\'s log');
  assert.ok(existsSync(join(dir, 'map', 'events.jsonl')));
});
