import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRun } from '../lib/events.mjs';

// Two machines (clones a and b) share a bare repo; each has its own state folder.
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'coordinator-sync-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const origin = join(root, 'origin.git');
const companion = join(root, 'companion.git');
const A = join(root, 'a'); const B = join(root, 'b');
mkdirSync(A);
git(A, 'init', '-q', '-b', 'main'); writeFileSync(join(A, 'README.md'), 'code\n'); git(A, 'add', '.'); git(A, 'commit', '-qm', 'code');
git(root, 'clone', '-q', '--bare', A, origin); git(root, 'init', '-q', '--bare', companion);
git(A, 'remote', 'add', 'origin', origin); git(A, 'fetch', '-q', 'origin'); git(A, 'remote', 'set-head', 'origin', 'main');
git(root, 'clone', '-q', origin, B);
const mainSha = git(origin, 'rev-parse', 'main').trim();

const stateDir = (m) => join(root, `${m === A ? 'a' : 'b'}-state`);
const configure = (m, c) => { mkdirSync(stateDir(m), { recursive: true }); writeFileSync(join(stateDir(m), 'coordinator.json'), JSON.stringify(c)); };
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const cli = (m, ...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { cwd: m, env: { ...process.env, COORDINATOR_DIR: stateDir(m) }, encoding: 'utf8' }); return { code: r.status, out: json(r.stdout), err: r.stderr }; };
const runDir = (m, r) => join(stateDir(m), 'runs', r);
const show = (ref, path) => git(origin, 'show', `${ref}:${path}`);
configure(A, { visibility: 'private' }); configure(B, { visibility: 'private' });

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

test('push writes the run, masked, to an orphan coordinator-state branch and never touches main', () => {
  cli(A, 'init', 'r1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); cli(A, 'add', 'r1', 'u1', '--bar', 'b');
  // A secret and a local path that got into the state by hand: the push masks both.
  const f = join(runDir(A, 'r1'), 'state.json');
  const s = JSON.parse(readFileSync(f, 'utf8')); s.notes.push({ kind: 'info', text: `token ${SECRET} in ${join(A, 'src', 'x.ts')}`, at: s.createdAt }); writeFileSync(f, JSON.stringify(s));
  writeFileSync(join(stateDir(A), 'lessons.json'), JSON.stringify([{ id: 'l1', tag: 'code', text: `see ${A}/notes`, seen: 1, used: 0 }]));
  const r = cli(A, 'push', 'r1', '--message', 'pit stop: u1 merged');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.pushed, true);
  assert.deepEqual(r.out.files, ['.coordinator-state', 'README.md', 'lessons/lessons.json', 'runs/r1/README.md', 'runs/r1/events.jsonl', 'runs/r1/state.json']);
  assert.equal(git(origin, 'rev-parse', 'main').trim(), mainSha, 'main is untouched');
  assert.equal(git(origin, 'rev-list', '--count', 'coordinator-state').trim(), '1', 'an orphan branch');
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'coordinator-state').trim(), 'pit stop: u1 merged');
  const pushed = ['runs/r1/events.jsonl', 'runs/r1/state.json', 'runs/r1/README.md', 'lessons/lessons.json'].map((p) => show('coordinator-state', p)).join('\n');
  assert.equal(pushed.includes(SECRET), false, 'no secret');
  assert.match(pushed, /\[redacted\]/);
  assert.equal(pushed.toLowerCase().includes(A.toLowerCase()) || pushed.toLowerCase().includes(A.replace(/\\/g, '\\\\').toLowerCase()), false, 'no local path');
  assert.match(pushed, /\.[\\/]+src[\\/]+x\.ts/);
  assert.equal(readFileSync(join(runDir(A, 'r1'), 'events.jsonl'), 'utf8').includes('state.edited'), true, 'the hand edit was recorded before pushing');
  const again = cli(A, 'push', 'r1'); assert.deepEqual(again.out.unchanged, true, again.err);
});

test('pull restores the run on another machine, and fast-forwards it later', () => {
  const r = cli(B, 'pull', 'r1');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'restored');
  assert.equal(r.out.lessons, 'restored');
  assert.equal(readFileSync(join(runDir(B, 'r1'), 'events.jsonl'), 'utf8'), show('coordinator-state', 'runs/r1/events.jsonl'));
  assert.equal(readRun(runDir(B, 'r1')).rebuilt, undefined, 'the snapshot it wrote is valid');
  assert.equal(existsSync(join(runDir(B, 'r1'), 'hud.html')), true);
  assert.equal(cli(B, 'show', 'r1').code, 0);
  assert.equal(cli(B, 'pull', 'r1').out.status, 'up-to-date');
  // B carries on and pushes; A picks up B's events.
  assert.equal(cli(B, 'freeze', 'r1').code, 0);
  assert.equal(cli(B, 'push', 'r1').code, 0);
  assert.equal(cli(B, 'pull', 'r1').out.status, 'up-to-date');
  const ff = cli(A, 'pull', 'r1');
  assert.equal(ff.code, 0, ff.err);
  assert.deepEqual([ff.out.status, ff.out.added], ['fast-forward', 1]);
  assert.equal(JSON.parse(readFileSync(join(runDir(A, 'r1'), 'state.json'), 'utf8')).frozen, true);
  assert.equal(readFileSync(join(runDir(A, 'r1'), 'events.jsonl'), 'utf8').includes(SECRET), true, 'local history is kept as it was');
  assert.equal(git(origin, 'rev-list', '--count', 'coordinator-state').trim(), '2');
});

test('pull never overwrites local events the copy lacks', () => {
  cli(A, 'note', 'r1', '--kind', 'info', '--text', 'only on a');
  assert.equal(cli(A, 'pull', 'r1').out.status, 'local-ahead');
  cli(B, 'note', 'r1', '--kind', 'info', '--text', 'only on b'); cli(B, 'push', 'r1');
  const before = readFileSync(join(runDir(A, 'r1'), 'events.jsonl'), 'utf8');
  const r = cli(A, 'pull', 'r1');
  assert.equal(r.code, 1); assert.match(r.err, /different histories after event 4/); assert.match(r.err, /nothing changed. To recover: move the local run folder aside/);
  assert.equal(readFileSync(join(runDir(A, 'r1'), 'events.jsonl'), 'utf8'), before);
  // Nor does push drop the other machine's events.
  const tip = git(origin, 'rev-parse', 'coordinator-state').trim();
  const p = cli(A, 'push', 'r1');
  assert.equal(p.code, 1); assert.match(p.err, /different histories after event 4; nothing pushed/); assert.match(p.err, /move the local run folder aside, run.mjs pull r1/);
  assert.equal(git(origin, 'rev-parse', 'coordinator-state').trim(), tip);
  assert.match(show('coordinator-state', 'runs/r1/events.jsonl'), /only on b/);
  // A machine that is merely behind is told to pull first.
  cli(B, 'note', 'r1', '--kind', 'info', '--text', 'b again'); cli(B, 'push', 'r1');
  rmSync(runDir(B, 'r1'), { recursive: true }); cli(B, 'pull', 'r1');
  cli(B, 'note', 'r1', '--kind', 'info', '--text', 'b third'); cli(B, 'push', 'r1');
  writeFileSync(join(runDir(B, 'r1'), 'events.jsonl'), show('coordinator-state', 'runs/r1/events.jsonl').split('\n').slice(0, 5).join('\n') + '\n');
  rmSync(join(runDir(B, 'r1'), 'state.json'));
  assert.match(cli(B, 'push', 'r1').err, /has events this machine lacks; run.mjs pull r1 first/);
  rmSync(runDir(B, 'r1'), { recursive: true }); assert.equal(cli(B, 'pull', 'r1').out.status, 'restored');
});

test('a failing pre-push hook fails the push with its message', () => {
  const hooks = join(root, 'hooks'); mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho "blocked by policy" >&2\nexit 1\n', { mode: 0o755 });
  git(B, 'config', 'core.hooksPath', hooks);
  const tip = git(origin, 'rev-parse', 'coordinator-state').trim();
  cli(B, 'note', 'r1', '--kind', 'info', '--text', 'hooked');
  const r = cli(B, 'push', 'r1');
  git(B, 'config', '--unset', 'core.hooksPath');
  assert.equal(r.code, 1); assert.match(r.err, /blocked by policy/);
  assert.equal(git(origin, 'rev-parse', 'coordinator-state').trim(), tip);
  assert.equal(cli(B, 'push', 'r1').code, 0);
});

test('pushes from two machines keep each other\'s runs, and closed runs add a stats line', () => {
  cli(B, 'init', 'r2', '--goal', 'g', '--bar', 'b', '--fence', 'f'); cli(B, 'add', 'r2', 'u', '--bar', 'b'); cli(B, 'freeze', 'r2');
  cli(B, 'close', 'r2', '--outcome', 'stopped', '--reason', 'test');
  assert.equal(cli(B, 'push', 'r2').code, 0);
  const tree = git(origin, 'ls-tree', '-r', '--name-only', 'coordinator-state');
  assert.match(tree, /runs\/r1\/events\.jsonl/); assert.match(tree, /runs\/r2\/events\.jsonl/);
  const stats = show('coordinator-state', 'stats/runs.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(stats.map((l) => [l.run, l.outcome, l.units]), [['r2', 'stopped', 1]]);
});

test('state never goes to main, a branch that is not ours, or a public repo without a private companion', () => {
  assert.match(cli(A, 'push', 'r1', '--to', 'main').err, /never goes to main/);
  git(A, 'push', '-q', 'origin', 'main:feature');
  assert.match(cli(A, 'push', 'r1', '--to', 'feature').err, /not a coordinator state branch/);
  assert.equal(git(origin, 'rev-parse', 'feature').trim(), mainSha);
  configure(A, { visibility: 'public' });
  assert.match(cli(A, 'push', 'r1').err, /public repo; set "stateRepo"/);
  assert.match(cli(A, 'push', 'r1', '--to', join(A, 'state-copy')).err, /public repo/, 'nor a folder inside it');
  configure(A, {});
  assert.match(cli(A, 'push', 'r1').err, /cannot tell whether the repo is public/, 'unknown visibility fails closed');
  configure(A, { visibility: 'public', stateRepo: companion });
  const tipBefore = git(origin, 'rev-parse', 'coordinator-state').trim();
  const r = cli(A, 'push', 'r1');
  assert.equal(r.code, 0, r.err);
  assert.match(git(companion, 'ls-tree', '-r', '--name-only', 'coordinator-state'), /runs\/r1\/events\.jsonl/);
  assert.equal(git(origin, 'rev-parse', 'coordinator-state').trim(), tipBefore, 'nothing more goes to the public repo');
  configure(A, { visibility: 'private' });
});

test('a folder works as the target and the source', () => {
  const folder = join(root, 'outside', 'state');
  const r = cli(A, 'push', 'r1', '--to', folder);
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(join(folder, 'runs', 'r1', 'events.jsonl')), true);
  writeFileSync(join(root, 'outside', 'other.txt'), 'x');
  assert.match(cli(A, 'push', 'r1', '--to', join(root, 'outside')).err, /not empty and holds no coordinator state/);
  rmSync(join(runDir(B, 'r1')), { recursive: true });
  const p = cli(B, 'pull', 'r1', '--from', folder);
  assert.equal(p.code, 0, p.err);
  assert.equal(p.out.status, 'restored');
  assert.equal(readFileSync(join(runDir(B, 'r1'), 'events.jsonl'), 'utf8'), readFileSync(join(folder, 'runs', 'r1', 'events.jsonl'), 'utf8'));
  assert.match(cli(B, 'pull', 'nope').err, /no run nope/);
});

test('answers and person notes made away are replayed after the lead\'s own later events, once, and nothing else is', () => {
  const folder = join(root, 'away', 'state');
  const ok = (r) => { assert.equal(r.code, 0, r.err); return r.out; };
  const kinds = (m) => readFileSync(join(runDir(m, 'r3'), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => `${e.seq}:${e.kind}`);
  ok(cli(A, 'init', 'r3', '--goal', 'g', '--bar', 'b', '--fence', 'f')); ok(cli(A, 'add', 'r3', 'u1', '--bar', 'b'));
  ok(cli(A, 'freeze', 'r3')); ok(cli(A, 'start', 'r3', 'u1'));
  ok(cli(A, 'ask', 'r3', '--question', 'Which?', '--header', 'Pick', '--option', 'x|the x', '--option', 'y|the y', '--unit', 'u1'));
  ok(cli(A, 'push', 'r3', '--to', folder));
  // The lead carries on locally after its pit stop.
  ok(cli(A, 'beat', 'r3', 'u1'));
  const seqBefore = kinds(A).length;
  // Away (machine B stands in for the web HUD): an answer, then a note.
  ok(cli(B, 'pull', 'r3', '--from', folder));
  ok(cli(B, 'answer', 'r3', 'q1', '--choice', 'y'));
  ok(cli(B, 'note', 'r3', '--kind', 'person', '--text', 'ship it', '--unit', 'u1'));
  ok(cli(B, 'push', 'r3', '--to', folder));
  const away = cli(B, 'questions', 'r3').out[0].answer;

  const p = ok(cli(A, 'pull', 'r3', '--from', folder));
  assert.deepEqual([p.status, p.replayed, p.seq], ['replayed', 2, seqBefore + 2]);
  assert.deepEqual(kinds(A).slice(-3), [`${seqBefore}:unit.beat`, `${seqBefore + 1}:answer`, `${seqBefore + 2}:note`], 'in the copy\'s order, renumbered after the beat');
  assert.deepEqual(cli(A, 'questions', 'r3').out[0].answer, away, 'the answer as it was given, with its time');
  assert.equal(readRun(runDir(A, 'r3')).rebuilt, undefined);
  // Idempotent: a second pull adds nothing.
  const again = ok(cli(A, 'pull', 'r3', '--from', folder));
  assert.deepEqual([again.status, again.replayed, kinds(A).length], ['local-ahead', 0, seqBefore + 2]);
  // The lead uses the answer, and its next pit stop replaces the copy's log with its own.
  ok(cli(A, 'use-answer', 'r3', 'q1'));
  ok(cli(A, 'push', 'r3', '--to', folder));
  assert.equal(readFileSync(join(folder, 'runs', 'r3', 'events.jsonl'), 'utf8'), readFileSync(join(runDir(A, 'r3'), 'events.jsonl'), 'utf8'));

  // A push never drops a note this machine has not replayed yet: pull first.
  rmSync(runDir(B, 'r3'), { recursive: true }); ok(cli(B, 'pull', 'r3', '--from', folder));
  ok(cli(B, 'note', 'r3', '--kind', 'person', '--text', 'one more'));
  ok(cli(B, 'push', 'r3', '--to', folder));
  ok(cli(A, 'beat', 'r3', 'u1'));
  assert.match(cli(A, 'push', 'r3', '--to', folder).err, /has answers or notes this machine lacks; run.mjs pull r3 first; nothing pushed/);
  assert.equal(ok(cli(A, 'pull', 'r3', '--from', folder)).replayed, 1);
  ok(cli(A, 'push', 'r3', '--to', folder));

  // Anything other than an answer or a person's note is refused, and nothing changes.
  rmSync(runDir(B, 'r3'), { recursive: true }); ok(cli(B, 'pull', 'r3', '--from', folder));
  ok(cli(B, 'note', 'r3', '--kind', 'person', '--text', 'fine'));
  ok(cli(B, 'note', 'r3', '--kind', 'info', '--text', 'lead-only kind'));
  ok(cli(B, 'push', 'r3', '--to', folder));
  ok(cli(A, 'beat', 'r3', 'u1'));
  const log = readFileSync(join(runDir(A, 'r3'), 'events.jsonl'), 'utf8');
  const r = cli(A, 'pull', 'r3', '--from', folder);
  assert.equal(r.code, 1); assert.match(r.err, /different histories/);
  assert.equal(readFileSync(join(runDir(A, 'r3'), 'events.jsonl'), 'utf8'), log);
});

test('an answer changed away after the lead used it is kept as a flagged note, and never wedges pull or push', () => {
  const folder = join(root, 'away4', 'state');
  const ok = (r) => { assert.equal(r.code, 0, r.err); return r.out; };
  ok(cli(A, 'init', 'r4', '--goal', 'g', '--bar', 'b', '--fence', 'f')); ok(cli(A, 'add', 'r4', 'u1', '--bar', 'b'));
  ok(cli(A, 'freeze', 'r4')); ok(cli(A, 'start', 'r4', 'u1'));
  ok(cli(A, 'ask', 'r4', '--question', 'Which?', '--header', 'Pick', '--option', 'x|the x', '--option', 'y|the y', '--unit', 'u1'));
  ok(cli(A, 'push', 'r4', '--to', folder));
  ok(cli(B, 'pull', 'r4', '--from', folder)); ok(cli(B, 'answer', 'r4', 'q1', '--choice', 'x')); ok(cli(B, 'push', 'r4', '--to', folder));
  ok(cli(A, 'pull', 'r4', '--from', folder)); ok(cli(A, 'use-answer', 'r4', 'q1')); ok(cli(A, 'beat', 'r4', 'u1'));
  // The person changes the answer before the lead's next push: the branch has not seen the use.
  ok(cli(B, 'answer', 'r4', 'q1', '--choice', 'y')); ok(cli(B, 'push', 'r4', '--to', folder));
  assert.equal(ok(cli(A, 'pull', 'r4', '--from', folder)).replayed, 1);
  const q = cli(A, 'questions', 'r4').out[0];
  assert.deepEqual([q.status, q.answer.choices], ['used', ['x']], 'the lead keeps the answer it used');
  const late = JSON.parse(readFileSync(join(runDir(A, 'r4'), 'state.json'), 'utf8')).notes.filter((n) => n.changedAfterUse);
  assert.equal(late.length, 1); assert.match(late[0].text, /answer changed after use: q1 → y/); assert.deepEqual(late[0].changedAfterUse.choices, ['y']);
  assert.equal(ok(cli(A, 'pull', 'r4', '--from', folder)).replayed, 0, 'a second pull adds nothing');
  ok(cli(A, 'push', 'r4', '--to', folder));
  ok(cli(A, 'beat', 'r4', 'u1')); ok(cli(A, 'push', 'r4', '--to', folder));
  assert.equal(ok(cli(A, 'pull', 'r4', '--from', folder)).status, 'up-to-date');
});

test('an answer changed away after the lead closed the question by a decision says so, not "after use"', () => {
  const folder = join(root, 'away4d', 'state');
  const ok = (r) => { assert.equal(r.code, 0, r.err); return r.out; };
  ok(cli(A, 'init', 'r4d', '--goal', 'g', '--bar', 'b', '--fence', 'f')); ok(cli(A, 'add', 'r4d', 'u1', '--bar', 'b'));
  ok(cli(A, 'freeze', 'r4d')); ok(cli(A, 'start', 'r4d', 'u1'));
  ok(cli(A, 'ask', 'r4d', '--question', 'Which?', '--header', 'Pick', '--option', 'x|the x', '--option', 'y|the y', '--unit', 'u1'));
  ok(cli(A, 'push', 'r4d', '--to', folder)); ok(cli(B, 'pull', 'r4d', '--from', folder));
  ok(cli(A, 'note', 'r4d', '--kind', 'decision', '--text', 'x, as recommended', '--answers', 'q1')); ok(cli(A, 'beat', 'r4d', 'u1'));
  ok(cli(B, 'answer', 'r4d', 'q1', '--choice', 'y')); ok(cli(B, 'push', 'r4d', '--to', folder));
  assert.equal(ok(cli(A, 'pull', 'r4d', '--from', folder)).replayed, 1);
  assert.equal(cli(A, 'questions', 'r4d').out[0].status, 'decided', 'the decision stands');
  const late = JSON.parse(readFileSync(join(runDir(A, 'r4d'), 'state.json'), 'utf8')).notes.filter((n) => n.changedAfterUse);
  assert.equal(late.length, 1);
  assert.equal(late[0].text, 'answer changed after the lead decided: q1 → y (the lead keeps its decision)');
  assert.doesNotMatch(late[0].text, /after use/);
  assert.equal(ok(cli(A, 'pull', 'r4d', '--from', folder)).replayed, 0, 'a second pull adds nothing');
});

test('a note or answer from the branch with fields run.mjs never writes is not replayed (no copy on every pull)', () => {
  const folder = join(root, 'away5', 'state');
  const ok = (r) => { assert.equal(r.code, 0, r.err); return r.out; };
  ok(cli(A, 'init', 'r5', '--goal', 'g', '--bar', 'b', '--fence', 'f')); ok(cli(A, 'add', 'r5', 'u1', '--bar', 'b'));
  ok(cli(A, 'freeze', 'r5')); ok(cli(A, 'start', 'r5', 'u1'));
  ok(cli(A, 'push', 'r5', '--to', folder)); ok(cli(A, 'beat', 'r5', 'u1'));
  const ev = join(folder, 'runs', 'r5', 'events.jsonl');
  const last = JSON.parse(readFileSync(ev, 'utf8').trim().split('\n').at(-1));
  writeFileSync(ev, readFileSync(ev, 'utf8') + `${JSON.stringify({ v: last.v, seq: last.seq + 1, at: new Date().toISOString(), kind: 'note', payload: { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'person', text: 'hi', unit: null, at: new Date().toISOString(), recommend: 'x' }] }] } })}\n`);
  const log = readFileSync(join(runDir(A, 'r5'), 'events.jsonl'), 'utf8');
  for (let i = 0; i < 2; i++) assert.match(cli(A, 'pull', 'r5', '--from', folder).err, /different histories/);
  assert.equal(readFileSync(join(runDir(A, 'r5'), 'events.jsonl'), 'utf8'), log);
});
