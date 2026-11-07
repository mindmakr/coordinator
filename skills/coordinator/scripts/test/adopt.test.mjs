// adopt: files a run mentions in a worktree are copied in, so deleting the
// worktree loses nothing; secrets are refused; adopting twice is a no-op; doctor
// catches a stored copy that went missing or changed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adopt, allowedRoots, pathsIn, refusal } from '../lib/adopt.mjs';
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
// A home folder that holds none of the scratch folders (the real one holds the OS temp folder).
const NOHOME = resolve('/no-such-home-for-tests');
const p = (f) => join(wt, f).replace(/\\/g, '/');

test('paths in text: absolute, Git Bash, relative, quoted, with spaces or brackets; URLs are not paths', () => {
  const raw = (t, ex) => pathsIn(t, ex).map((x) => (x.unclear ? `?${x.raw}` : x.raw));
  assert.deepEqual(raw('see D:/x/wt/shot.png, C:\\Users\\a\\r.md and /c/tmp/a.json; https://x.com/a.png ./out/log.txt (docs/v1.md). bare.md'),
    ['D:/x/wt/shot.png', 'C:\\Users\\a\\r.md', '/c/tmp/a.json', './out/log.txt', 'docs/v1.md']);
  assert.deepEqual(raw('saved "C:/Users/John Smith/x.png" and `D:/a b/r (1).md`'), ['C:/Users/John Smith/x.png', 'D:/a b/r (1).md']);
  const real = new Set(['C:/Users/John Smith/x.png', 'D:/wt/shot (1).png', 'D:/wt/a, b; c.pdf']);
  assert.deepEqual(raw('saved C:/Users/John Smith/x.png, then D:/wt/shot (1).png and D:/wt/a, b; c.pdf', (c) => real.has(c)),
    ['C:/Users/John Smith/x.png', 'D:/wt/shot (1).png', 'D:/wt/a, b; c.pdf']);
  assert.deepEqual(raw('saved C:/Users/John Smith/gone.png'), ['?C:/Users/John Smith/gone.png'], 'not found with a space: unclear, never a wrong guess');
  assert.deepEqual(raw('logs in /tmp/a and /tmp/b/gone.png'), ['/tmp/b/gone.png']);
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
  assert.match(first, /adopted 3, repaired 0, already 0, inside 0, tracked 0, missing 1, unclear 0, refused 2/);
  assert.match(first, /refused\s+u1\s+.*credentials\.json\s+\(looks like a secret/);
  assert.match(first, /refused\s+u1\s+.*log\.txt\s+\(inside node_modules/);
  const files = (d) => readdirSync(join(runDir, 'artifacts', d)).sort();
  assert.deepEqual(files('u1'), ['E1-report.md', 'E2-shot.png']);
  assert.deepEqual(files('_goal'), ['E1-out.pdf']);
  const all = readdirSync(join(runDir, 'artifacts'), { recursive: true }).map(String);
  assert.ok(!all.some((f) => f.includes('credentials')), 'the secret file was not copied');
  const s = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  assert.equal(s.goalEvidence[0].kind, 'pdf', 'an adopted PDF is a pdf, not a log');
  assert.deepEqual(s.units[0].evidence.map((e) => e.kind), ['log', 'screenshot']);

  assert.match(run('adopt', 'r1'), /adopted 0, repaired 0, already 3,/, 'a second adopt changes nothing');
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').length;
  run('adopt', 'r1');
  assert.ok(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').length <= events + 1);

  // A changed stored copy, while its source still exists: doctor names the source, adopt repairs it.
  writeFileSync(join(runDir, 'artifacts', 'u1', 'E1-report.md'), 'tampered');
  const tampered = artifactsCheck({ base: state, project, home: NOHOME }).find((x) => x.status === 'fail');
  assert.match(tampered.text, /E1-report\.md changed \(sha256 mismatch\)/);
  assert.match(tampered.fix, /run\.mjs adopt r1 \(copies it again from .*report\.md\)/);
  assert.match(run('adopt', 'r1'), /repaired 1,/);
  assert.equal(readFileSync(join(runDir, 'artifacts', 'u1', 'E1-report.md'), 'utf8'), '# Report\nAll green.\n');
  assert.equal(artifactsCheck({ base: state, project, home: NOHOME })[0].status, 'ok');

  rmSync(wt, { recursive: true, force: true });
  run('note', 'r1', '--kind', 'info', '--text', 'worktree removed');
  const hud = readFileSync(join(runDir, 'hud.html'), 'utf8');
  const unit = readFileSync(join(runDir, 'units', 'u1.html'), 'utf8');
  assert.match(unit, /data:image\/png;base64,/, 'the screenshot is still shown');
  assert.match(unit, /E1-report\.md/);
  assert.match(hud, /E1-out\.pdf/);
  assert.ok(!/missing \(the stored copy is gone\)/.test(unit + hud));
  const ok = artifactsCheck({ base: state, project, home: NOHOME })[0];
  assert.equal(ok.status, 'ok'); assert.doesNotMatch(ok.text, /adopted/, 'never claims "adopted"');

  rmSync(join(runDir, 'artifacts', 'u1', 'E2-shot.png'));
  run('note', 'r1', '--kind', 'info', '--text', 'rerender');
  const after2 = readFileSync(join(runDir, 'units', 'u1.html'), 'utf8');
  assert.match(after2, /E2-shot\.png: missing \(the stored copy is gone\)/);
  assert.ok(!/data:image\/png;base64,/.test(after2));
  const missing = artifactsCheck({ base: state, project, home: NOHOME })[0];
  assert.equal(missing.status, 'fail'); assert.match(missing.text, /E2-shot\.png missing/);
  assert.match(missing.fix, /is gone: re-run the step that made it, then run\.mjs evidence r1 u1 --file/);
  assert.doesNotMatch(missing.fix, /pull/);
});

test('the live server answers 404, not 500, for a stored copy that is gone', async () => {
  const child = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'r1'], { cwd: project, env: { ...process.env, COORDINATOR_DIR: state } });
  try {
    const url = await new Promise((ok, bad) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; const m = /"url":\s*"([^"]+)"/.exec(buf); if (m) ok(m[1]); });
      child.on('exit', () => bad(new Error('serve exited')));
    });
    const u = new URL(url);
    const t = u.searchParams.get('t');
    assert.equal((await fetch(`${u.origin}/artifacts/u1/E2-shot.png?t=${t}`)).status, 404);
    assert.equal((await fetch(`${u.origin}/artifacts/u1/E1-report.md?t=${t}`)).status, 200);
    assert.ok(existsSync(join(runDir, 'serve.json')), 'serve records itself for doctor');
  } finally {
    const gone = new Promise((ok) => child.once('exit', ok)); child.kill(); await gone;
  }
});

test('adopt refuses home configuration and anything outside the allowed roots; unclear paths are flagged', () => {
  const home = join(root, 'home'); const elsewhere = join(root, 'elsewhere');
  for (const d of ['.claude', '.docker', 'AppData/Roaming/app', 'AppData/Local/Temp/scratch']) mkdirSync(join(home, d), { recursive: true });
  mkdirSync(elsewhere);
  const f = (...x) => { const q = join(...x); writeFileSync(q, '{"a":1}'); return q.replace(/\\/g, '/'); };
  const files = {
    claudeJson: f(home, '.claude.json'), settings: f(home, '.claude', 'settings.json'), docker: f(home, '.docker', 'config.json'),
    roaming: f(home, 'AppData', 'Roaming', 'app', 'log.json'), temp: f(home, 'AppData', 'Local', 'Temp', 'scratch', 'r.json'),
    outside: f(elsewhere, 'r.json'),
  };
  writeFileSync(join(elsewhere, 'shot (1).png'), PNG);
  const bracketed = join(elsewhere, 'shot (1).png').replace(/\\/g, '/');
  const s = { id: 'x', units: [], notes: [{ kind: 'info', text: `${Object.values(files).join(' ')} ~/.claude/settings.json and "${bracketed}" and C:/Nobody Here/gone.png` }] };
  const rows = adopt(s, join(state, 'runs', 'x'), { project, home, tracked: new Set(), roots: [project, join(home, 'AppData', 'Local', 'Temp')] });
  const by = (q) => rows.find((r) => r.path.replace(/\\/g, '/').toLowerCase() === q.toLowerCase());
  for (const k of ['claudeJson', 'settings', 'docker', 'roaming']) assert.match(by(files[k]).why, /home configuration/, k);
  assert.equal(by(files.temp).status, 'adoptable', 'scratch under the temp folder is allowed');
  assert.match(by(files.outside).why, /outside allowed roots/);
  assert.match(by(bracketed).why, /outside allowed roots/, 'a quoted path with brackets is read whole');
  assert.ok(rows.some((r) => r.status === 'unclear'));
});

test('doctor: an unadopted mention warns; close warns too', () => {
  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  writeFileSync(join(scratch, 'notes.md'), 'n');
  run('init', 'r2', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('note', 'r2', '--kind', 'info', '--text', `kept in ${join(scratch, 'notes.md').replace(/\\/g, '/')}`);
  const w = artifactsCheck({ base: state, project, home: NOHOME }).find((x) => x.text.startsWith('r2'));
  assert.equal(w.status, 'warn'); assert.equal(w.fix, 'run.mjs adopt r2');
  const closed = JSON.parse(run('close', 'r2', '--outcome', 'stopped', '--reason', 'test'));
  assert.match(closed.warning, /run\.mjs adopt r2/);
  assert.match(run('adopt', 'r2'), /adopted 1,/, 'adopt works on a closed run');
});

test('prose that starts with / is not a path, and never makes doctor warn', () => {
  const prose = [
    'reverted /map 500 without reason; ship events+md (map.json',
    'service: / move cards in other repos (incl. private board.json',
    'route /employers/:id/minor-holds rule; see the holds report.md',
  ];
  for (const t of prose) assert.deepEqual(pathsIn(t).filter((x) => x.unclear), [], t);
  const s = { id: 'p', units: [], notes: prose.map((text) => ({ kind: 'info', text })) };
  assert.deepEqual(adopt(s, join(state, 'runs', 'p'), { project, home: NOHOME, tracked: new Set() }).filter((r) => r.status === 'unclear'), []);
  const dir = join(state, 'runs', 'p'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(s));
  assert.ok(!artifactsCheck({ base: state, project, home: NOHOME }).some((x) => x.text.startsWith('p:')), 'no warning for run p');
  rmSync(dir, { recursive: true });
  // A spaced reading still counts when its folder exists.
  const real = join(root, 'has space'); mkdirSync(real);
  const t = `saved ${real.replace(/\\/g, '/')}/gone (1).png`;
  assert.equal(pathsIn(t, () => false, (c) => existsSync(dirname(c))).filter((x) => x.unclear).length, 1);
});

test('home is never an allowed root; hard links outside the project are refused; old adopted PDFs are re-tagged', () => {
  const home = join(root, 'home2'); mkdirSync(home);
  assert.ok(!allowedRoots(project, home, home).includes(resolve(home)), 'COORDINATOR_DIR=home is left out');
  assert.ok(!allowedRoots(project, root, home).includes(resolve(root)), 'a root holding home is left out');
  const src = join(root, 'linked-src.md'); writeFileSync(src, 'x');
  const link = join(root, 'linked.md'); linkSync(src, link);
  assert.match(refusal(link, { roots: [root], project }), /hard link/);
  const inProject = join(project, 'own.md'); writeFileSync(inProject, 'x'); linkSync(inProject, join(project, 'own2.md'));
  assert.equal(refusal(inProject, { roots: [project], project }), null, 'a hard link inside the project is fine');

  const dir = join(state, 'runs', 'old'); mkdirSync(join(dir, 'artifacts', '_goal'), { recursive: true });
  const pdf = join(root, 'plan.pdf'); writeFileSync(pdf, '%PDF-1.4\n');
  writeFileSync(join(dir, 'artifacts', '_goal', 'E1-plan.pdf'), '%PDF-1.4\n');
  const s = { id: 'old', units: [], goalEvidence: [{ id: 'E1', kind: 'log', type: 'doc', file: '_goal/E1-plan.pdf', source: pdf }], notes: [{ kind: 'info', text: `plan ${pdf.replace(/\\/g, '/')}` }] };
  adopt(s, dir, { project, home: NOHOME, tracked: new Set(), apply: true });
  assert.equal(s.goalEvidence[0].kind, 'pdf');
  rmSync(dir, { recursive: true });
});
