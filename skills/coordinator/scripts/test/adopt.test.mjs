// adopt: files a run mentions in a worktree are copied in, so deleting the
// worktree loses nothing; secrets are refused; adopting twice is a no-op; doctor
// catches a stored copy that went missing or changed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathsIn } from '../lib/adopt.mjs';
import { artifactsCheck } from '../lib/doctor.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'coord-adopt-'));
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, 'proj'); const state = join(root, 'state'); const wt = join(root, 'wt-u1');
mkdirSync(project); mkdirSync(join(wt, 'node_modules', 'x'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: project });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
writeFileSync(join(wt, 'shot.png'), PNG);
writeFileSync(join(wt, 'report.md'), '# Report\nAll green.\n');
writeFileSync(join(wt, 'out.pdf'), '%PDF-1.4\n%fake\n');
writeFileSync(join(wt, 'credentials.json'), '{"api_key":"Sup3rS3cretValue99"}\n');
writeFileSync(join(wt, 'node_modules', 'x', 'log.txt'), 'dep log');

const cli = (...args) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: project, env: { ...process.env, COORDINATOR_DIR: state }, encoding: 'utf8' });
const run = (...a) => { const r = cli(...a); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const runDir = join(state, 'runs', 'r1');
const p = (f) => join(wt, f).replace(/\\/g, '/');

test('paths in text: absolute, Git Bash, relative; URLs are not paths', () => {
  assert.deepEqual(pathsIn('see D:/x/wt/shot.png, C:\\Users\\a\\r.md and /c/tmp/a.json; https://x.com/a.png ./out/log.txt (docs/v1.md). bare.md'),
    ['D:/x/wt/shot.png', 'C:\\Users\\a\\r.md', '/c/tmp/a.json', './out/log.txt', 'docs/v1.md']);
});

test('adopt copies mentioned files in, refuses secrets, is idempotent, and pages survive the worktree going', () => {
  run('init', 'r1', '--goal', `ship it; plan in ${p('out.pdf')}`, '--bar', 'b', '--fence', 'f');
  run('add', 'r1', 'u1', '--bar', 'b');
  run('freeze', 'r1'); run('start', 'r1', 'u1');
  run('built', 'r1', 'u1', '--report', `done, see ${p('report.md')}; creds in ${p('credentials.json')}; ${p('node_modules/x/log.txt')}`);
  run('verdict', 'r1', 'u1', 'pass', '--evidence', `screenshot ${p('shot.png')} and ${p('gone.png')}`, '--score', '9');

  const dry = run('adopt', 'r1', '--dry-run');
  assert.match(dry, /adoptable 3,/);
  assert.ok(!existsSync(join(runDir, 'artifacts')), 'a dry run copies nothing');

  const first = run('adopt', 'r1');
  assert.match(first, /adopted 3, already 0, inside 0, tracked 0, missing 1, refused 2/);
  assert.match(first, /refused\s+u1\s+.*credentials\.json\s+\(looks like a secret/);
  assert.match(first, /refused\s+u1\s+.*log\.txt\s+\(inside node_modules/);
  const files = (d) => readdirSync(join(runDir, 'artifacts', d)).sort();
  assert.deepEqual(files('u1'), ['E1-report.md', 'E2-shot.png']);
  assert.deepEqual(files('_goal'), ['E1-out.pdf']);
  const all = readdirSync(join(runDir, 'artifacts'), { recursive: true }).map(String);
  assert.ok(!all.some((f) => f.includes('credentials')), 'the secret file was not copied');

  assert.match(run('adopt', 'r1'), /adopted 0, already 3,/, 'a second adopt changes nothing');
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').length;
  run('adopt', 'r1');
  assert.ok(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').length <= events + 1);

  rmSync(wt, { recursive: true, force: true });
  run('note', 'r1', '--kind', 'info', '--text', 'worktree removed');
  const hud = readFileSync(join(runDir, 'hud.html'), 'utf8');
  const unit = readFileSync(join(runDir, 'units', 'u1.html'), 'utf8');
  assert.match(unit, /data:image\/png;base64,/, 'the screenshot is still shown');
  assert.match(unit, /E1-report\.md/);
  assert.match(hud, /E1-out\.pdf/);
  assert.ok(!/missing \(the stored copy is gone\)/.test(unit + hud));
  assert.equal(artifactsCheck({ base: state, project, home: root })[0].status, 'ok');

  rmSync(join(runDir, 'artifacts', 'u1', 'E2-shot.png'));
  run('note', 'r1', '--kind', 'info', '--text', 'rerender');
  const after2 = readFileSync(join(runDir, 'units', 'u1.html'), 'utf8');
  assert.match(after2, /E2-shot\.png: missing \(the stored copy is gone\)/);
  assert.ok(!/data:image\/png;base64,/.test(after2));
  const missing = artifactsCheck({ base: state, project, home: root });
  assert.equal(missing[0].status, 'fail'); assert.match(missing[0].text, /E2-shot\.png missing/);
});

test('doctor: a changed stored file fails its sha256; an unadopted mention warns; close warns too', () => {
  writeFileSync(join(runDir, 'artifacts', 'u1', 'E1-report.md'), 'tampered');
  const r = artifactsCheck({ base: state, project, home: root });
  assert.ok(r.some((x) => x.status === 'fail' && /E1-report\.md changed \(sha256 mismatch\)/.test(x.text)));

  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  writeFileSync(join(scratch, 'notes.md'), 'n');
  run('init', 'r2', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('note', 'r2', '--kind', 'info', '--text', `kept in ${join(scratch, 'notes.md').replace(/\\/g, '/')}`);
  const w = artifactsCheck({ base: state, project, home: root }).find((x) => x.text.startsWith('r2'));
  assert.equal(w.status, 'warn'); assert.equal(w.fix, 'run.mjs adopt r2');
  const closed = JSON.parse(run('close', 'r2', '--outcome', 'stopped', '--reason', 'test'));
  assert.match(closed.warning, /run\.mjs adopt r2/);
  assert.match(run('adopt', 'r2'), /adopted 1,/, 'adopt works on a closed run');
});
