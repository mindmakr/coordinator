// The speed fixes' pure parts: suite records and the machine-wide suite lock, the pre-checks, the closed-list check
// for behaviours, follow-up triage and the batch unit, the lead's context budget, the fast run read for pages, and
// the git folder found without starting git.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { runSync } from './inproc.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { loadRun, peekRun, updateRun } from '../lib/events.mjs';
import { addFollowup, batchItems, batchWait } from '../lib/followups.mjs';
import { budgetCheck, MAX, usages, WARN } from '../lib/leadctx.mjs';
import { unboundedRefusal, unboundedWords } from '../lib/openbar.mjs';
import { precheck, precheckRules } from '../lib/precheck.mjs';
import { parseDiff } from '../lib/gaming.mjs';
import { gitCommonDir, holdLock, lockHeld } from '../lib/store.mjs';
import { addedFiles, changedLines, commitOf, diffText, fileAt, namedIn } from '../lib/gitdiff.mjs';
import { recordSuite, runSuite, sameHead, suiteFor, summaryLines } from '../lib/suites.mjs';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coord-speed-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('suite records: one per head, found by a short or a full sha, summary lines kept', () => {
  const u = { id: 'u1' };
  assert.throws(() => recordSuite(u, { head: 'nope', ok: true, results: ['x'], at: 't' }), /--head/);
  assert.throws(() => recordSuite(u, { head: 'abcdef1', ok: true, results: [], at: 't' }), /result line/);
  recordSuite(u, { head: 'ABCDEF1234', ok: true, results: ['# pass 671'], at: 't1' });
  assert.equal(suiteFor(u, 'abcdef1234567890').results[0], '# pass 671');
  assert.equal(suiteFor(u, 'abcdef0'), null);
  assert.equal(suiteFor(u, undefined), null);
  assert.ok(sameHead('abcdef1', 'ABCDEF1234') && !sameHead('abc', 'abcdef1'));
  for (let i = 0; i < 12; i++) recordSuite(u, { head: `aaaaaa${i.toString(16)}`, ok: false, results: ['fail'], at: `t${i}` });
  assert.equal(u.suites.length, 10, 'the last ten are kept');
  assert.deepEqual(summaryLines('compiling\n# tests 5\n# pass 5\n# fail 0\nbye\n'), ['# tests 5', '# pass 5', '# fail 0']);
});

test('runSuite runs an argument list, never a shell string; cmd.exe only for plain words', () => {
  const ok = runSuite([process.execPath, '-e', 'console.log("# pass 3")']);
  assert.equal(ok.code, 0); assert.match(ok.output, /# pass 3/);
  assert.equal(runSuite([process.execPath, '-e', 'process.exit(3)']).code, 3);
  assert.throws(() => runSuite([]), /give the command after --/);
  const calls = [];
  const fake = (cmd, args) => { calls.push([cmd, ...args]); return calls.length === 1 ? { error: Object.assign(new Error('x'), { code: 'EINVAL' }) } : { status: 0, stdout: '', stderr: '' }; };
  runSuite(['npm', 'test'], { spawn: fake, platform: 'win32' });
  assert.deepEqual(calls[1].slice(1), ['/d', '/c', 'npm', 'test']);
  calls.length = 0;
  assert.throws(() => runSuite(['npm', 'test', '&', 'calc'], { spawn: fake, platform: 'win32' }), /not a plain word/);
});

test('holdLock: one holder at a time, a dead holder is taken over, a live one waits then refuses', () => {
  const f = join(tmp, 'suite.lock');
  const release = holdLock(f, { run: 'r' });
  let told = null;
  assert.throws(() => holdLock(f, {}, { waitMs: 200, onWait: (h) => { told = h; } }), /lock busy/);
  assert.equal(told.run, 'r');
  release();
  holdLock(f, {}, { waitMs: 0 })();
  writeFileSync(f, JSON.stringify({ pid: 999999, at: 'x' }));
  holdLock(f, {}, { waitMs: 1000, alive: () => false })(); // gone: taken over
});

test('precheck: CHANGELOG edits, invisible characters, URL pathnames, unlisted tests, untested modules', () => {
  const rules = precheckRules({ testList: ['package.json'], modules: ['src/lib'] });
  const diff = [
    'diff --git a/CHANGELOG.md b/CHANGELOG.md', '@@ -1 +1,2 @@', '+- a line',
    'diff --git a/src/lib/a.mjs b/src/lib/a.mjs', '@@ -0,0 +1,3 @@',
    `+const s = 'a${String.fromCharCode(0x200b)}b';`,
    `+const f = readFileSync(new URL('./x.json', import.meta.url).${'path'}name);`, // split here so this file is no hit itself
    `+// a comment that names new URL(x, import.meta.url).${'path'}name is no hit`,
    "+const ok = fileURLToPath(new URL('./x.json', import.meta.url));",
  ].join('\n');
  const hits = precheck({ files: parseDiff(diff), added: ['src/lib/a.mjs', 'test/new.test.mjs', 'test/listed.test.mjs'] }, rules, {
    lists: [{ file: 'package.json', text: '"test": "node --test test/listed.test.mjs"' }],
    mentioned: (name) => name !== 'a.mjs',
  });
  assert.deepEqual(hits.map((h) => `${h.rule} ${h.file}`), ['changelog CHANGELOG.md', 'invisible src/lib/a.mjs', 'pathname src/lib/a.mjs', 'untested src/lib/a.mjs', 'test-list test/new.test.mjs']);
  assert.match(hits[1].detail, /U\+200B/);
  // A glob in the list covers new files; a list in a sub-folder only covers its own folder; rules can be turned off.
  const svc = precheckRules({ testList: ['service/package.json'], off: ['changelog'] });
  assert.deepEqual(precheck({ files: parseDiff(diff), added: ['service/test/x.test.mjs', 'other/y.test.mjs'] }, svc, { lists: [{ file: 'service/package.json', text: '--test test/*.test.mjs' }] }).map((h) => h.rule), ['invisible', 'pathname']);
  assert.throws(() => precheckRules({ off: ['nope'] }), /no rule "nope"/);
  assert.throws(() => precheckRules({ tests: '(' }), /precheck.tests/);
  assert.deepEqual(precheckRules(false).off.length, 5);
});

test('behaviours: unbounded words are refused unless the cases are listed or --open says why', () => {
  assert.deepEqual(unboundedWords('the total is right'), []);
  assert.deepEqual(unboundedWords('never grants more than approved'), ['never']);
  assert.deepEqual(unboundedWords('All pages and every form'), ['all', 'every']);
  assert.deepEqual(unboundedWords('every page in: home, cart and checkout'), []);
  assert.deepEqual(unboundedWords('any of the listed roles'), []);
  assert.deepEqual(unboundedWords('all three (admin, owner, viewer) see it'), []);
  assert.deepEqual(unboundedWords('only 1) the owner 2) an admin'), []);
  assert.deepEqual(unboundedWords('Overall the tally holds'), [], 'whole words only');
  assert.match(unboundedRefusal([{ what: 'u1 B1', text: 'never leaks' }]), /u1 B1 reads open-ended \(never\).*--open/);
  assert.equal(unboundedRefusal([{ what: 'u1 B1', text: 'never leaks', open: 'the leak paths are the three endpoints' }]), null);
});

test('follow-ups: batch items make one batch unit that builds last; issues and drops are notes', () => {
  const s = { id: 'r', units: [{ id: 'a', status: 'building' }], notes: [] };
  assert.throws(() => addFollowup(s, { text: 't', triage: 'P9', reason: 'r', at: 'x' }), /--triage/);
  assert.equal(addFollowup(s, { text: 'fix a typo', triage: 'batch', reason: 'small', at: 'x' }).unit, 'batch');
  addFollowup(s, { text: 'tighten a test', triage: 'batch', reason: 'small', at: 'y' });
  const b = s.units.find((u) => u.id === 'batch');
  assert.equal(s.units.filter((u) => u.batch).length, 1, 'one batch unit');
  assert.match(b.bar, /\(1\) fix a typo; \(2\) tighten a test/);
  assert.equal(batchItems(s).length, 2);
  assert.match(addFollowup(s, { text: 'race in sync', triage: 'P1', reason: 'real bug', at: 'z' }).file, /issue \(P1\)/);
  assert.equal(addFollowup(s, { text: 'nice to have', triage: 'P3', reason: 'later', at: 'z' }).file, undefined);
  assert.match(batchWait(b, s).reason, /builds last, after a/);
  s.units[0].status = 'pass';
  assert.equal(batchWait(b, s), null);
  b.status = 'pass';
  assert.throws(() => addFollowup(s, { text: 'late', triage: 'batch', reason: 'r', at: 'z' }), /batch unit is pass/);
});

test('lead context: warn over 250k, refuse over 300k until a compaction or a handover note', () => {
  const turn = (at, tokens) => JSON.stringify({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0 } } });
  const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(budgetCheck(usages(turn('t1', 1000))).level, 'ok');
  assert.equal(budgetCheck(usages(turn('t1', WARN + 1))).level, 'warn');
  const over = usages([turn('t1', 200_000), turn('t2', MAX + 5), turn('t3', MAX + 50), 'not json'].join('\n'));
  const c = budgetCheck(over, []);
  assert.deepEqual([c.level, c.since], ['over', 't2']);
  assert.match(c.text, /lead step refused/);
  assert.equal(budgetCheck(over, [{ kind: 'decision', text: 'handover: see notes', at: 't1' }]).level, 'over', 'a handover from before it went over does not count');
  assert.equal(budgetCheck(over, [{ kind: 'decision', text: 'Handover: see notes', at: 't2' }]).level, 'warn');
  assert.equal(budgetCheck(usages([turn('t1', MAX + 5), compact, turn('t4', 40_000)].join('\n'))).level, 'ok', 'a compaction resets it');
  assert.equal(budgetCheck([]), null);
});

test('peekRun reads the snapshot when it is newer than the log, and the full log otherwise', () => {
  const dir = join(tmp, 'run1');
  updateRun(dir, { kind: 'run.init' }, () => ({ id: 'run1', goal: 'g', bar: 'b', fence: 'f', units: [], notes: [], budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, createdAt: 'x', frozen: false }));
  updateRun(dir, { kind: 'note' }, (s) => { s.notes.push({ kind: 'info', text: 'one', at: 'x' }); });
  assert.deepEqual(peekRun(dir), loadRun(dir));
  // A log newer than its snapshot (a pull that appended events): the full read.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, 'events.jsonl'), later, later);
  assert.deepEqual(peekRun(dir), loadRun(dir));
});

test('gitCommonDir finds a checkout\'s .git and a worktree\'s main .git without starting git', () => {
  const repo = join(tmp, 'repo'); mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); writeFileSync(join(repo, 'a'), 'a'); git('add', '-A'); git('commit', '-qm', 'a');
  git('worktree', 'add', '-q', join(tmp, 'wt'));
  mkdirSync(join(repo, 'sub'));
  const real = (p) => p.replace(/\\/g, '/').toLowerCase();
  assert.equal(real(gitCommonDir(join(repo, 'sub'))), real(join(repo, '.git')));
  assert.equal(real(gitCommonDir(join(tmp, 'wt'))), real(join(repo, '.git')));
  assert.equal(gitCommonDir(repo, { GIT_DIR: 'x' }), undefined, 'git is asked when GIT_DIR is set');
});

// ---- the commands, in process (test/inproc.mjs) ----
const state = mkdtempSync(join(tmpdir(), 'coord-speed-cli-'));
after(() => rmSync(state, { recursive: true, force: true }));
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const cli = (args, extra = {}, cwd) => { const r = runSync(args, { env: { ...process.env, COORDINATOR_DIR: state, ...extra }, cwd }); return { code: r.status, out: json(r.stdout), raw: r.stdout, err: r.stderr }; };
const ok = (...a) => { const r = cli(a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const unitOfRun = (run, u) => loadRun(join(state, 'runs', run)).units.find((x) => x.id === u);

test('suite: runs the command after -- under the machine lock and records it; critics of that head cite it', () => {
  ok('init', 's1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 's1', 'u', '--bar', 'b'); ok('freeze', 's1'); ok('start', 's1', 'u');
  ok('built', 's1', 'u', '--head', 'abcdef1234');
  const r = ok('suite', 's1', 'u', '--head', 'abcdef1234', '--', process.execPath, '-e', 'console.log("# tests 3"); console.log("# pass 3")');
  assert.deepEqual([r.suite.ok, r.suite.results], [true, ['# tests 3', '# pass 3']]);
  const brief = cli(['brief', 's1', 'u', '--role', 'critic', '--lessons', '0']).raw;
  assert.match(brief, /The lead ran the full suite on this head \(abcdef1234, passed\): # tests 3 \| # pass 3\. Do not run the full suite/);
  assert.doesNotMatch(brief, /run the full suite once on the head/);
  const failed = ok('suite', 's1', 'u', '--head', 'abcdef1234', '--', process.execPath, '-e', 'console.log("# fail 1"); process.exit(1)');
  assert.equal(failed.suite.ok, false);
  assert.match(cli(['brief', 's1', 'u', '--role', 'critic', '--lessons', '0']).raw, /abcdef1234, FAILED/);
  assert.equal(ok('suite', 's1', 'u', '--head', 'abcdef1234', '--result', '# pass 9').suite.results[0], '# pass 9');
  assert.match(cli(['suite', 's1', 'u', '--head', 'abcdef1234']).err, /usage: run.mjs suite/);
  assert.match(cli(['suite', 's1', 'u', '--head', 'xyz', '--result', 'r']).err, /--head takes the commit/);
  // A builder brief says mapped tests only, no CHANGELOG edits, and to run the precheck.
  const b = cli(['brief', 's1', 'u', '--role', 'builder', '--lessons', '0']).raw;
  assert.match(b, /Never the full suite: the lead runs it once on the head/);
  assert.match(b, /Never edit CHANGELOG\.md.*built s1 u --changelog/);
  assert.match(b, /run\.mjs precheck s1 u --base <base> --head <your commit>/);
});

test('suite: a second full suite on this machine waits for the lock', async () => {
  const lock = join(process.env.COORDINATOR_HOME, 'suite.lock');
  const store = new URL('../lib/store.mjs', import.meta.url).href;
  // Another process holds the suite lock for 1.5 s.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { holdLock } from ${JSON.stringify(store)}; const r = holdLock(process.argv[1], { run: 'other', unit: 'x' }); console.log('held'); setTimeout(r, 1500);`, lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => holder.stdout.once('data', r));
  const t0 = Date.now();
  const r = cli(['suite', 's1', 'u', '--head', 'abcdef1234', '--', process.execPath, '-e', 'console.log("# pass 1")']);
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 >= 1000, 'it waited for the other suite');
  assert.match(r.err, /waiting: a full suite is running on this machine \(run other, unit x/);
  await new Promise((ok2) => (holder.exitCode !== null ? ok2() : holder.once('exit', ok2)));
});

// A git project for the commands that read commits (precheck, built --head): returns its folder and a commit helper.
function project(name) {
  const root = join(state, name); mkdirSync(root);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = (files, msg = 'c') => { for (const [f, body] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), body); } git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
  return { root, commit };
}

test('precheck and built: a CHANGELOG edit is a hit, built refuses that head, --skip-precheck --reason keeps it (logged)', () => {
  const p = project('pre');
  const base = p.commit({ 'CHANGELOG.md': '# Changes\n', 'src/a.mjs': 'export const a = 1;\n' });
  const head = p.commit({ 'CHANGELOG.md': '# Changes\n- mine\n' });
  const run = (...a) => cli(a, {}, p.root);
  for (const a of [['init', 'p1', '--goal', 'g', '--bar', 'b', '--fence', 'f'], ['add', 'p1', 'u', '--bar', 'b'], ['freeze', 'p1'], ['start', 'p1', 'u']]) assert.equal(run(...a).code, 0);
  const pre = run('precheck', 'p1', 'u', '--base', base, '--head', head);
  assert.equal(pre.code, 1, 'a hit exits 1');
  assert.deepEqual(pre.out.hits.map((h) => `${h.rule} ${h.file}`), ['changelog CHANGELOG.md']);
  const refused = run('built', 'p1', 'u', '--head', head);
  assert.equal(refused.code, 1); assert.match(refused.err, /built refused: the precheck of .* has 1 hit\(s\): changelog CHANGELOG\.md/);
  assert.match(run('built', 'p1', 'u', '--head', head, '--skip-precheck').err, /missing --reason/);
  assert.equal(run('built', 'p1', 'u', '--head', head, '--skip-precheck', '--reason', 'the release unit writes it', '--changelog', 'Faster suites').code, 0);
  const st = loadRun(join(state, 'runs', 'p1'));
  assert.ok(st.notes.some((n) => n.kind === 'decision' && /precheck hits kept .*: the release unit writes it/.test(n.text)));
  assert.equal(st.units[0].changelog, 'Faster suites');
  assert.equal(run('changelog', 'p1').raw, '- Faster suites\n');
  // A clean head passes built with --base: the precheck runs there.
  assert.equal(run('add', 'p1', 'v', '--bar', 'b', '--reason', 'more').code, 0);
  const clean = p.commit({ 'src/b.mjs': 'export const b = 2;\n' });
  assert.equal(run('start', 'p1', 'v').code, 0);
  assert.equal(run('built', 'p1', 'v', '--base', head, '--head', clean).code, 0);
  assert.deepEqual(unitOfRun('p1', 'v').precheck.hits, []);
});

test('followup: batch items make one batch unit that waits for every other unit; P1 says to file it', () => {
  ok('init', 'f1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'f1', 'a', '--bar', 'b'); ok('freeze', 'f1');
  const one = ok('followup', 'f1', '--text', 'fix the README typo', '--triage', 'batch', '--reason', 'one line');
  assert.equal(one.batchUnit, 'batch');
  ok('followup', 'f1', '--text', 'tighten the totals test', '--triage', 'batch', '--reason', 'small');
  assert.match(ok('followup', 'f1', '--text', 'sync race', '--triage', 'p1', '--reason', 'real bug').step, /file it as an issue \(P1\)/);
  assert.match(cli(['followup', 'f1', '--text', 'x', '--triage', 'batch']).err, /missing --reason/);
  let next = ok('next', 'f1');
  assert.deepEqual(next.units.map((u) => [u.id, u.action]), [['a', 'build'], ['batch', 'wait']]);
  assert.match(next.units[1].reason, /batch: builds last, after a/);
  ok('start', 'f1', 'a'); ok('built', 'f1', 'a'); ok('verdict', 'f1', 'a', 'pass', '--evidence', 'ok', '--score', '9');
  next = ok('next', 'f1');
  assert.equal(next.units[1].action, 'build');
  assert.match(cli(['brief', 'f1', 'batch', '--role', 'builder', '--lessons', '0']).raw, /Bar: every batch item is done, with one test run: \(1\) fix the README typo; \(2\) tighten the totals test[\s\S]*This is the batch unit/);
});

test('paths: a unit whose paths overlap a unit being built waits; separate paths build together', () => {
  ok('init', 'o1', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  ok('add', 'o1', 'api', '--bar', 'b', '--paths', 'src/api');
  ok('add', 'o1', 'api2', '--bar', 'b', '--paths', 'src/api/users.ts');
  ok('add', 'o1', 'web', '--bar', 'b', '--paths', 'web/');
  ok('freeze', 'o1'); ok('start', 'o1', 'api');
  const next = ok('next', 'o1');
  assert.deepEqual(next.units.map((u) => [u.id, u.action]), [['api', 'wait'], ['api2', 'wait'], ['web', 'build']]);
  assert.match(next.units[1].reason, /paths overlap api, being built/);
  assert.equal(cli(['start', 'o1', 'api2']).code, 1);
  assert.equal(cli(['start', 'o1', 'web']).code, 0);
});

test('one critic on a small delta from round 2: the specialist judges alone and closes the round', () => {
  const p = project('solo');
  const h1 = p.commit({ 'a.js': 'export const a = 1;\n' });
  const run = (...a) => cli(a, {}, p.root);
  const okp = (...a) => { const r = run(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
  okp('init', 'c1', '--goal', 'g', '--bar', 'b', '--fence', 'f'); okp('add', 'c1', 'u', '--bar', 'b', '--specialist', 'security'); okp('freeze', 'c1');
  okp('start', 'c1', 'u'); okp('built', 'c1', 'u', '--head', h1);
  // Round 1: both critics, as before.
  okp('verdict', 'c1', 'u', 'fail', '--specialist', 'security', '--severity', 'high', '--gap', 'g', '--evidence', 'e', '--score', '4');
  okp('verdict', 'c1', 'u', 'fail', '--severity', 'high', '--gap', 'g', '--evidence', 'e', '--score', '4', '--head', h1);
  const h2 = p.commit({ 'a.js': 'export const a = 2;\n' });
  okp('start', 'c1', 'u'); okp('built', 'c1', 'u', '--head', h2);
  assert.equal(unitOfRun('c1', 'u').delta.lines, 2);
  const judge = okp('next', 'c1').units[0];
  assert.deepEqual([judge.action, judge.critics, judge.critic, judge.deltaLines], ['judge', 1, 'security', 2]);
  assert.match(run('brief', 'c1', 'u', '--role', 'critic', '--lessons', '0').raw, /You are the only critic of this round \(a 2-line delta\): judge the general bar/);
  assert.match(run('verdict', 'c1', 'u', 'pass', '--evidence', 'e', '--score', '9').err, /one critic judges round 2 \(a 2-line delta\): security/);
  okp('verdict', 'c1', 'u', 'pass', '--specialist', 'security', '--evidence', 'e', '--score', '9');
  const u = unitOfRun('c1', 'u');
  assert.deepEqual([u.status, u.rounds[1].oneCritic, u.rounds[1].deltaLines], ['pass', 'security', 2]);
  assert.match(run('verdict', 'c1', 'u', 'pass', '--evidence', 'e', '--score', '9').err, /verdict refused/, 'a second verdict on that round is refused');
});

test('freeze refuses an unbounded behaviour; --open keeps it, logged; the same behaviour failing twice asks the person', () => {
  ok('init', 'b1', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  ok('add', 'b1', 'u', '--bar', 'b', '--behaviour', 'the total is right');
  assert.match(cli(['behave', 'b1', 'u', '--text', 'it never grants more than approved']).err, /reads open-ended \(never\)/);
  ok('behave', 'b1', 'u', '--text', 'it grants only these: read, write');
  ok('freeze', 'b1');
  ok('start', 'b1', 'u'); ok('built', 'b1', 'u');
  ok('verdict', 'b1', 'u', 'fail', '--severity', 'high', '--gap', 'g1', '--evidence', 'e', '--score', '5', '--behaviour', 'B1=fail:"wrong"', '--behaviour', 'B2=pass:"ok"');
  assert.equal(ok('next', 'b1').units[0].action, 'build');
  ok('start', 'b1', 'u'); ok('built', 'b1', 'u');
  ok('verdict', 'b1', 'u', 'fail', '--severity', 'high', '--gap', 'g2 elsewhere', '--evidence', 'e', '--score', '6', '--behaviour', 'B1=fail:"still wrong"', '--behaviour', 'B2=pass:"ok"');
  const d = ok('next', 'b1').units[0];
  assert.equal(d.action, 'ask-person'); assert.match(d.reason, /same-behaviour: B1/);
  const asked = ok('ask', 'b1', '--finish', 'u');
  assert.match(loadRun(join(state, 'runs', 'b1')).notes.filter((n) => n.kind === 'question').at(-1).text, /failed review twice, and both times on the same behaviour: B1 \("the total is right"\)/);
  assert.equal(ok('next', 'b1').units[0].asked, asked.asked);
  // A goal behaviour kept with --open, then freeze takes it.
  ok('init', 'b2', '--goal', 'g', '--bar', 'b', '--fence', 'f'); ok('add', 'b2', 'u', '--bar', 'b');
  assert.match(cli(['behave', 'b2', '--goal', '--text', 'every page loads']).err, /reads open-ended \(every\)/);
  ok('behave', 'b2', '--goal', '--text', 'every page loads', '--open', 'the pages are the sitemap');
  assert.equal(loadRun(join(state, 'runs', 'b2')).goalBehaviours[0].open, 'the pages are the sitemap');
  ok('freeze', 'b2');
});

test('next --all lists the runs this window leads; the lead context budget warns, then refuses lead steps until a handover', () => {
  const lead = { COORDINATOR_LEAD: 'lead-all' };
  for (const r of ['n1', 'n2']) { assert.equal(cli(['init', r, '--goal', 'g', '--bar', 'b', '--fence', 'f'], lead).code, 0); assert.equal(cli(['add', r, 'u', '--bar', 'b'], lead).code, 0); }
  const all = cli(['next', '--all'], lead).out;
  assert.deepEqual(all.runs.map((r) => [r.run, r.decision]), [['n1', 'split'], ['n2', 'split']]);
  assert.deepEqual(cli(['next', '--all'], { COORDINATOR_LEAD: 'someone-else' }).out.runs, []);
  const transcript = join(state, 'lead.jsonl');
  const turn = (tokens) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: { input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } });
  writeFileSync(transcript, `${turn(260_000)}\n`);
  const env = { ...lead, COORDINATOR_TRANSCRIPT: transcript };
  assert.equal(cli(['next', 'n1'], env).out.context.level, 'warn');
  writeFileSync(transcript, `${turn(310_000)}\n`);
  const refused = cli(['freeze', 'n1'], env);
  assert.equal(refused.code, 1); assert.match(refused.err, /lead step refused: the lead's context is 310k/);
  assert.equal(cli(['note', 'n1', '--kind', 'decision', '--text', 'handover: n1 at freeze, nothing built'], env).code, 0);
  assert.equal(cli(['freeze', 'n1'], env).code, 0);
});

test('gitdiff.mjs: commits, the diff and its added files, changed lines, a file at a commit, and names in test files', () => {
  const p = project('gd');
  const a = p.commit({ 'lib/x.mjs': 'export const x = 1;\n', 'test/x.test.mjs': "import { x } from '../lib/x.mjs';\n" });
  const b = p.commit({ 'lib/x.mjs': 'export const x = 2;\nexport const y = 3;\n', 'lib/new.mjs': 'export {};\n' });
  assert.equal(commitOf(p.root, a.slice(0, 8)), a);
  assert.throws(() => commitOf(p.root, '--upload-pack=x'), /bad --ref/);
  assert.throws(() => commitOf(p.root, 'nope'), /not a commit here/);
  assert.match(diffText(p.root, a, b), /\+export const y = 3;/);
  assert.deepEqual(addedFiles(p.root, a, b), ['lib/new.mjs']);
  assert.equal(changedLines(p.root, a, b), 4);
  assert.equal(changedLines(p.root, a, 'nope'), null);
  assert.equal(fileAt(p.root, b, 'lib/new.mjs'), 'export {};\n');
  assert.equal(fileAt(p.root, b, 'missing.txt'), null);
  assert.equal(namedIn(p.root, b, 'x.mjs', /\.test\.mjs$/), true);
  assert.equal(namedIn(p.root, b, 'new.mjs', /\.test\.mjs$/), false);
});

test('coordinator.html is written by a background writer: the change returns first, a burst ends with the last change in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-speed-snap-'));
  const env = { ...process.env, COORDINATOR_DIR: dir, COORDINATOR_SNAPSHOT: 'background', COORDINATOR_REGISTRY: 'off', COORDINATOR_LEAD: 'snap-lead' };
  for (const k of ['NODE_TEST_CONTEXT', 'CLAUDE_CODE_SESSION_ID', 'COORDINATOR_TRANSCRIPT']) delete env[k];
  const node = (...a) => execFileSync(process.execPath, [join(scriptsDir, 'run.mjs'), ...a], { env, encoding: 'utf8' });
  const page = join(dir, 'coordinator.html');
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  // Settled: the last stamp is covered and no writer holds the lock (the writer's own signal, not a pause).
  const settled = async (what) => {
    for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 25))) {
      if (read(`${page}.want`) && read(`${page}.want`) === read(`${page}.done`) && !lockHeld(`${page}.writer`)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    }
  };
  try {
    node('init', 'bg', '--goal', 'g', '--bar', 'b', '--fence', 'f');
    await settled('the first page');
    assert.match(read(page), /Snapshot written/);
    // A writer that died holding the lock does not block the next one.
    writeFileSync(`${page}.writer`, JSON.stringify({ pid: 999999, at: 'x' }));
    for (let i = 0; i < 5; i++) node('add', 'bg', `burst-${i}`, '--bar', 'b');
    await settled('the burst');
    assert.match(read(page), /burst-4/, 'the page holds the last change of the burst');
    // A writer with nothing new to cover renders nothing.
    const before = statSync(page).mtimeMs;
    node('self', '--html', '--queued');
    assert.equal(statSync(page).mtimeMs, before);
    assert.match(spawnSync(process.execPath, [join(scriptsDir, 'run.mjs'), 'self', '--queued'], { env, encoding: 'utf8' }).stderr, /--queued goes with --html/);
  } finally { await settled('the last writer').catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
