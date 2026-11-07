// Stored evidence files are read only from artifacts/<target>/<E-name>: a `file` value
// in the state that climbs out (.., absolute, a drive letter, a backslash) never
// enters the state through an event, and no reader follows it or a link out.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStored, readStored, storedPath } from '../lib/evidence.mjs';
import { validRun, validateEvent } from '../lib/eventschema.mjs';
import { hud, staticCtx } from '../lib/hud.mjs';
import { decide } from '../lib/rules.mjs';
import { unitPage } from '../lib/unitpage.mjs';
import { view } from '../lib/view.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coord-artpath-'));
const children = [];
after(async () => {
  await Promise.all(children.map((c) => new Promise((ok) => { if (c.exitCode !== null) return ok(); c.once('exit', ok); c.kill(); })));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const env = { ...process.env, COORDINATOR_DIR: join(dir, 'state') };
const run = (...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8', cwd: dir });
const runDir = (r) => join(dir, 'state', 'runs', r);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const SECRET = 'TOP-SECRET-1d9f';
// A secret next to the run folder, and a PNG-looking one, for every way out.
writeFileSync(join(dir, 'secret.txt'), SECRET);
writeFileSync(join(dir, 'E1-secret.png'), Buffer.concat([PNG, Buffer.from(SECRET)]));
const BAD = ['u1/../../../secret.txt', '../secret.txt', '/etc/passwd', `${dir.replace(/\\/g, '/')}/secret.txt`, 'C:/Windows/win.ini', 'u1/C:/x.txt', 'u1/..\\..\\..\\secret.txt', 'u1\\E1-x.png', 'u1/E1-..png', 'u1/sub/E1-x.png', 'E1-x.png', 'u1/x.png', '_goal/../../secret.txt'];
// A link out: a junction (Windows, no privilege needed) or a directory symlink.
const linkDir = (target, path) => symlinkSync(target, path, 'junction');
const tryLink = (target, path) => { try { symlinkSync(target, path, 'file'); return true; } catch { return false; } }; // Windows needs Developer Mode

test('storedPath accepts only <target>/E<n>-<name> directly inside artifacts/<target>/, never through a link', () => {
  const rd = join(dir, 'sp'); mkdirSync(join(rd, 'artifacts', 'u1'), { recursive: true }); mkdirSync(join(rd, 'artifacts', '_goal'));
  writeFileSync(join(rd, 'artifacts', 'u1', 'E1-ok.png'), PNG); writeFileSync(join(rd, 'artifacts', '_goal', 'E1-g.log'), 'g');
  assert.equal(storedPath(rd, 'u1/E1-ok.png'), join(rd, 'artifacts', 'u1', 'E1-ok.png'));
  assert.equal(storedPath(rd, '_goal/E1-g.log'), join(rd, 'artifacts', '_goal', 'E1-g.log'));
  for (const f of [...BAD, null, undefined, 42, '']) assert.equal(storedPath(rd, f), null, String(f));
  assert.equal(storedPath(null, 'u1/E1-ok.png'), null);
  assert.equal(storedPath(rd, 'u1/E2-none.png'), null, 'not there');
  mkdirSync(join(rd, 'artifacts', 'u1', 'E3-dir.png'));
  assert.equal(storedPath(rd, 'u1/E3-dir.png'), null, 'a folder is not a file');
  if (tryLink(join(dir, 'secret.txt'), join(rd, 'artifacts', 'u1', 'E4-link.log'))) assert.equal(storedPath(rd, 'u1/E4-link.log'), null, 'a file link');
  mkdirSync(join(dir, 'outside')); writeFileSync(join(dir, 'outside', 'E1-x.png'), PNG);
  linkDir(join(dir, 'outside'), join(rd, 'artifacts', 'u2'));
  assert.equal(storedPath(rd, 'u2/E1-x.png'), null, 'a linked target folder');
  const rd2 = join(dir, 'sp2'); mkdirSync(rd2); mkdirSync(join(dir, 'arts', 'u1'), { recursive: true }); writeFileSync(join(dir, 'arts', 'u1', 'E1-x.png'), PNG);
  linkDir(join(dir, 'arts'), join(rd2, 'artifacts'));
  assert.equal(storedPath(rd2, 'u1/E1-x.png'), null, 'a linked artifacts folder');
});

test('no event, replay or state can bring in an evidence file outside <target>/E<n>-<name>; good ones still load', () => {
  const ev = (ops, kind = 'evidence') => ({ v: 1, seq: 2, at: '2026-01-01T00:00:00Z', kind, ...(kind === 'state.edited' ? {} : { unit: 'u1' }), payload: { ops } });
  const item = (file) => ({ id: 'E1', kind: 'log', at: '2026-01-01T00:00:00Z', file, type: 'text' });
  for (const f of BAD) {
    assert.throws(() => validateEvent(ev([{ op: 'push', path: ['units', { id: 'u1' }, 'evidence'], values: [item(f)] }])), /evidence file .* is not <unit>\/E<n>-<name>/, `push ${f}`);
    assert.throws(() => validateEvent(ev([{ op: 'set', path: ['units', { id: 'u1' }, 'evidence', { id: 'E1' }, 'file'], value: f }])), /evidence file/, `set file ${f}`);
    assert.throws(() => validateEvent(ev([{ op: 'set', path: ['units', { id: 'u1' }, 'evidence', { id: 'E1' }], value: item(f) }])), /evidence file/, `set item ${f}`);
    assert.throws(() => validateEvent(ev([{ op: 'set', path: ['goalEvidence'], value: [item(f)] }], 'state.edited')), /evidence file/, `goal ${f}`);
    assert.throws(() => validateEvent(ev([{ op: 'push', path: ['units'], values: [{ id: 'u2', evidence: [item(f)] }] }], 'unit.add')), /evidence file/, `a unit ${f}`);
    const st = { id: 'r', units: [{ id: 'u1', evidence: [item(f)] }] };
    assert.throws(() => validateEvent({ v: 1, seq: 1, at: '2026-01-01T00:00:00Z', kind: 'run.imported', payload: { state: st } }), /evidence file/, `import ${f}`);
    assert.match(validRun(st), /evidence file/, `state ${f}`);
  }
  assert.doesNotThrow(() => validateEvent(ev([{ op: 'push', path: ['units', { id: 'u1' }, 'evidence'], values: [item('u1/E1-server.log'), { id: 'E2', kind: 'test', text: 'ok' }] }])));
  assert.doesNotThrow(() => validateEvent(ev([{ op: 'set', path: ['units', { id: 'u1' }, 'rounds', 0, 'evidence'], value: 'see ../x and C:/y' }], 'unit.verdict')), 'a round\'s evidence is prose');
  assert.equal(validRun({ id: 'r', goalEvidence: [item('_goal/E1-a.md')], units: [{ id: 'A.1', evidence: [item('A.1/E12-a-b_c.png')], behaviours: [{ id: 'B1', evidence: 'u1/../x' }] }] }), null);
});

test('snapshot: a state naming a path out reads nothing outside artifacts/, for logs, embedded images and has()', () => {
  const rd = join(dir, 'snap'); mkdirSync(join(rd, 'artifacts', 'u1'), { recursive: true });
  const ups = '../'.repeat(3);
  const ev = [
    { id: 'E1', kind: 'log', label: 'l', at: '2026-01-01T00:01:00Z', file: `u1/${ups}secret.txt`, type: 'text' },
    { id: 'E2', kind: 'screenshot', label: 's', at: '2026-01-01T00:02:00Z', file: `u1/${ups}E1-secret.png`, type: 'image' },
    { id: 'E3', kind: 'log', label: 'a', at: '2026-01-01T00:03:00Z', file: `${dir.replace(/\\/g, '/')}/secret.txt`, type: 'text' },
    { id: 'E4', kind: 'log', label: 'b', at: '2026-01-01T00:04:00Z', file: 'u1/..\\..\\..\\secret.txt', type: 'text' },
    { id: 'E5', kind: 'screenshot', label: 'j', at: '2026-01-01T00:05:00Z', file: 'u2/E1-secret.png', type: 'image' },
  ];
  linkDir(dir, join(rd, 'artifacts', 'u2')); // u2 -> the folder holding the secrets
  const s = {
    id: 'r1', tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [], notes: [], createdAt: '2026-01-01T00:00:00Z', frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null,
    budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
    units: [{ id: 'u1', bar: 'b', after: null, status: 'open', rounds: [], evidence: ev, log: ev.map((e) => ({ kind: 'evidence', text: `${e.id} ${e.kind}: ${e.label}`, at: e.at })) }],
  };
  const v = view(s, decide(s, Date.parse('2026-01-01T01:00:00Z')), Date.parse('2026-01-01T01:00:00Z'));
  const b64 = Buffer.from(SECRET).toString('base64').slice(0, 12);
  for (const html of [hud(v, 0, staticCtx(rd, 0)), unitPage(v, 'u1', 0, staticCtx(rd, 1))]) {
    assert.ok(!html.includes(SECRET), 'no secret text');
    assert.ok(!html.includes('data:image/png;base64,iVBORw0KGgoAAAAA'), 'no embedded secret image');
    assert.ok(!html.includes(b64));
    assert.doesNotMatch(html, /data-evv-item/, 'nothing opens');
    assert.equal((html.match(/missing \(the stored copy is gone\)/g) ?? []).length, 5, 'each one reads as missing');
  }
});

test('live route: a link inside artifacts/ to outside is not served or embedded; a hand-edited state.json path never loads', async () => {
  run('init', 'L1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', 'L1', 'u1', '--bar', 'b'); run('freeze', 'L1');
  writeFileSync(join(dir, 'shot.png'), PNG); writeFileSync(join(dir, 'out.log'), 'fine');
  assert.equal(run('evidence', 'L1', 'u1', '--kind', 'screenshot', '--file', join(dir, 'shot.png')).status, 0);
  assert.equal(run('evidence', 'L1', 'u1', '--kind', 'log', '--file', join(dir, 'out.log')).status, 0);
  // Swap the unit's artifacts folder for a link to a folder holding a secret under the stored names.
  const arts = join(runDir('L1'), 'artifacts', 'u1');
  const names = readdirSync(arts);
  const out = join(dir, 'evil'); mkdirSync(out);
  for (const n of names) writeFileSync(join(out, n), n.endsWith('.png') ? Buffer.concat([PNG, Buffer.from(SECRET)]) : SECRET);
  renameSync(arts, join(dir, 'moved-away'));
  linkDir(out, arts);
  // A hand edit naming a path out: state.json no longer matches its snapshot record, so the log is replayed.
  const sf = join(runDir('L1'), 'state.json');
  const st = JSON.parse(readFileSync(sf, 'utf8'));
  st.units[0].evidence.push({ id: 'E3', kind: 'log', at: '2026-01-01T00:00:00Z', file: 'u1/../../../../secret.txt', type: 'text' });
  writeFileSync(sf, JSON.stringify(st));
  assert.equal(run('hud', 'L1').status, 0);
  for (const f of ['hud.html', 'units/u1.html']) {
    const html = readFileSync(join(runDir('L1'), f), 'utf8');
    assert.ok(!html.includes(SECRET) && !html.includes(Buffer.from(SECRET).toString('base64').slice(0, 12)), f);
    assert.doesNotMatch(html, /E3 log/, 'the hand-edited item never loaded');
  }
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'L1', '--port', '0'], { env, cwd: dir });
  children.push(c);
  const url = await new Promise((ok, bad) => { let b = ''; c.stdout.on('data', (d) => { b += d; const m = /"url": ?"([^"]+)"/.exec(b); if (m) ok(m[1]); }); c.once('exit', () => bad(new Error('serve exited'))); });
  const { origin } = new URL(url); const t = new URL(url).searchParams.get('t');
  const get = (p) => new Promise((ok) => httpGet(`${origin}${p}`, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => ok({ status: res.statusCode, body: d })); }));
  for (const n of names) assert.equal((await get(`/artifacts/u1/${n}?t=${t}`)).status, 404, n);
  for (const p of ['/artifacts/u1/..%2F..%2F..%2F..%2Fsecret.txt', '/artifacts/u1/..%5C..%5Csecret.txt', '/artifacts/u1/C%3A%2Fsecret.txt', '/artifacts/u1/%2Fetc%2Fpasswd']) {
    const r = await get(`${p}?t=${t}`);
    assert.notEqual(r.status, 200, p); assert.ok(!r.body.includes(SECRET), p);
  }
  for (const p of ['/', '/unit/u1']) {
    const r = await get(`${p}?t=${t}`);
    assert.equal(r.status, 200); assert.ok(!r.body.includes(SECRET), p);
    assert.match(r.body, /missing/, `${p} says missing`);
  }
  // A log line naming a path out stops the read: pull or replay cannot bring it in.
  const lf = join(runDir('L1'), 'events.jsonl');
  const lines = readFileSync(lf, 'utf8').trimEnd().split('\n');
  const bad = { v: 1, seq: lines.length + 1, at: '2026-01-01T00:00:00Z', kind: 'evidence', unit: 'u1', payload: { ops: [{ op: 'set', path: ['units', { id: 'u1' }, 'evidence', { id: 'E1' }, 'file'], value: 'u1/../../../../secret.txt' }] } };
  writeFileSync(lf, `${lines.join('\n')}\n${JSON.stringify(bad)}\n`);
  writeFileSync(sf, '{}');
  const r = run('hud', 'L1');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /evidence file .* is not <unit>\/E<n>-<name>/);
});

test('a hard link to a file elsewhere is refused: by storedPath, readStored and openStored, in the snapshot and on the live route', async () => {
  run('init', 'H1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', 'H1', 'u1', '--bar', 'b'); run('freeze', 'H1');
  writeFileSync(join(dir, 'h.png'), PNG); writeFileSync(join(dir, 'h.log'), 'fine log');
  assert.equal(run('evidence', 'H1', 'u1', '--kind', 'screenshot', '--file', join(dir, 'h.png')).status, 0);
  assert.equal(run('evidence', 'H1', 'u1', '--kind', 'log', '--file', join(dir, 'h.log')).status, 0);
  const rd = runDir('H1'); const arts = join(rd, 'artifacts', 'u1');
  const [png, log] = ['.png', '.log'].map((x) => readdirSync(arts).find((n) => n.endsWith(x)));
  assert.equal(readStored(rd, `u1/${log}`, 'utf8'), 'fine log', 'a stored copy with one name reads');
  const fd = openStored(rd, `u1/${png}`); assert.notEqual(fd, null); closeSync(fd);
  // Replace both with hard links to secrets outside the run folder.
  writeFileSync(join(dir, 'hl-secret.log'), SECRET); writeFileSync(join(dir, 'hl-secret.png'), Buffer.concat([PNG, Buffer.from(SECRET)]));
  for (const [n, src] of [[png, 'hl-secret.png'], [log, 'hl-secret.log']]) { unlinkSync(join(arts, n)); linkSync(join(dir, src), join(arts, n)); }
  for (const n of [png, log]) {
    assert.equal(storedPath(rd, `u1/${n}`), null, n); assert.equal(readStored(rd, `u1/${n}`), null, n); assert.equal(openStored(rd, `u1/${n}`), null, n);
  }
  assert.equal(run('hud', 'H1').status, 0);
  for (const f of ['hud.html', 'units/u1.html']) {
    const html = readFileSync(join(rd, f), 'utf8');
    assert.ok(!html.includes(SECRET) && !html.includes(Buffer.from(SECRET).toString('base64').slice(0, 12)), f);
    assert.match(html, /missing \(the stored copy is gone\)/, `${f} says missing`);
  }
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'H1', '--port', '0'], { env, cwd: dir });
  children.push(c);
  const url = await new Promise((ok, bad) => { let b = ''; c.stdout.on('data', (d) => { b += d; const m = /"url": ?"([^"]+)"/.exec(b); if (m) ok(m[1]); }); c.once('exit', () => bad(new Error('serve exited'))); });
  const { origin } = new URL(url); const t = new URL(url).searchParams.get('t');
  for (const n of [png, log]) {
    const r = await new Promise((ok) => httpGet(`${origin}/artifacts/u1/${n}?t=${t}`, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => ok({ status: res.statusCode, body: d })); }));
    assert.equal(r.status, 404, n); assert.ok(!r.body.includes(SECRET));
  }
  // A fresh copy (one name again) is served.
  unlinkSync(join(arts, log)); writeFileSync(join(arts, log), 'fine log');
  const ok = await new Promise((done) => httpGet(`${origin}/artifacts/u1/${log}?t=${t}`, (res) => { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => done({ status: res.statusCode, body: d })); }));
  assert.equal(ok.status, 200); assert.equal(ok.body, 'fine log');
});
