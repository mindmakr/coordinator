// Prism's visual gate (references/prism.md): the gate report is read and checked against its tokens and the
// commit being judged; a FAIL report blocks a pass; the prism specialist needs a PASS one from the judging
// phase; a build that changes the contract is flagged; doctor checks the folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prismCheck, realExec } from '../lib/doctor.mjs';
import { allowed, detect } from '../lib/gaming.mjs';
import { evidenceList } from '../lib/parts.mjs';
import { parsePrismReport, prismGate, prismRefusal, sameHead, tokensHash } from '../lib/prismreport.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-prism-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args) => {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: join(dir, 'state') }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};
const state = (r) => JSON.parse(readFileSync(join(dir, 'state', 'runs', r, 'state.json'), 'utf8'));

const HEAD1 = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const TOKENS = '{"color":{"surface":"#ffffff","ink":"#111111"}}\n';
const report = (over = {}) => ({
  schema: 1, status: 'PASS', head: HEAD1, tokensSha256: tokensHash(Buffer.from(TOKENS)), round: 1, tool: { name: 'prism', version: '0.1.0' },
  checks: [{ target: 'settings', state: 'default', viewport: '1440', status: 'PASS' }], violations: [], ...over,
});
const failing = (over = {}) => report({ status: 'FAIL', checks: [{ target: 'settings', status: 'FAIL' }], violations: [{ rule: 'raw-colour', target: 'settings', state: 'empty', viewport: '390x844', detail: '#3a3a3a in .card, not a token' }], ...over });
let n = 0;
// A worktree's .prism/ folder: its tokens and one gate report. Returns the report's path.
function worktree(rep, tokens = TOKENS) {
  const p = join(dir, `w${n++}`, '.prism');
  mkdirSync(p, { recursive: true });
  if (tokens !== null) writeFileSync(join(p, 'tokens.json'), tokens);
  writeFileSync(join(p, 'gate-report.json'), typeof rep === 'string' ? rep : JSON.stringify(rep, null, 2));
  return join(p, 'gate-report.json');
}

test('a gate report is read: its status, commit, tokens and what it found', () => {
  const ok = parsePrismReport(JSON.stringify({ ...report({ violations: [{ rule: 'contrast', target: 'chart', detail: 'axis label at 3.9:1', fixable: false }] }), extra: 'a field from a newer Prism' }));
  assert.deepEqual([ok.status, ok.head, ok.round, ok.tool.name], ['PASS', HEAD1, 1, 'prism']);
  assert.deepEqual(ok.checks, { total: 1, failed: 0 });
  assert.deepEqual(ok.violations, [{ rule: 'contrast', where: 'chart', detail: 'axis label at 3.9:1', fixable: false }], 'a PASS may list what cannot be fixed');
  assert.equal(ok.extra, undefined, 'unknown fields are not carried');
  const many = parsePrismReport(JSON.stringify(failing({ violations: Array.from({ length: 25 }, (_, i) => ({ rule: 'raw-colour', target: `s${i}`, state: 'empty', viewport: '390x844', detail: `token=ghp_${'x'.repeat(36)} in .card` })) })));
  assert.deepEqual([many.violations.length, many.more], [20, 5]);
  assert.equal(many.violations[0].where, 's0 · empty · 390x844');
  assert.doesNotMatch(JSON.stringify(many), /ghp_x{36}/, 'secrets in the report are masked');
  assert.equal(sameHead('aaaaaaa', HEAD1), true);
  assert.equal(sameHead('aaaaaa', HEAD1), false, 'six characters name nothing');
  assert.equal(sameHead('AAAAAAAA', HEAD1), true);
});

test('a report that is malformed or contradicts itself is refused, with the reason', () => {
  const bad = [
    ['not json', /not JSON/],
    ['[]', /not a gate report/],
    [JSON.stringify(report({ schema: 2 })), /schema 2 is not one this coordinator reads/],
    [JSON.stringify(report({ status: 'pass' })), /status must be PASS or FAIL/],
    [JSON.stringify(report({ head: 'abc1234' })), /full commit id/],
    [JSON.stringify(report({ tokensSha256: 'x' })), /tokensSha256 must be/],
    [JSON.stringify(report({ round: 0 })), /round must be/],
    [JSON.stringify(report({ checks: 'all' })), /checks must be a list/],
    [JSON.stringify(report({ violations: [7] })), /every entry of violations must be an object/],
    [JSON.stringify(report({ checks: [{ status: 'ok' }] })), /every check needs a status/],
    [JSON.stringify(report({ violations: [{ rule: 'raw-colour' }] })), /says PASS but lists 1 fixable violation/],
    [JSON.stringify(report({ checks: [{ status: 'FAIL' }, { status: 'FAIL' }] })), /says PASS but lists 2 failed checks/],
    [JSON.stringify(report({ status: 'FAIL', checks: [] })), /says FAIL but names no failed check/],
  ];
  for (const [text, re] of bad) assert.throws(() => parsePrismReport(text), re, text.slice(0, 60));
});

test('a build that changes the visual contract is flagged; assets and other files are not', () => {
  const diff = [
    'diff --git a/.prism/tokens.json b/.prism/tokens.json', '--- a/.prism/tokens.json', '+++ b/.prism/tokens.json', '@@ -1 +1 @@', '-{"ink":"#111111"}', '+{"ink":"#333333"}',
    'diff --git a/apps/web/.prism/anchors/settings.png b/apps/web/.prism/anchors/settings.png', 'new file mode 100644', 'Binary files /dev/null and b/apps/web/.prism/anchors/settings.png differ',
    'diff --git a/.prism/dials.json b/.prism/dials.json', 'deleted file mode 100644', '--- a/.prism/dials.json', '+++ /dev/null', '@@ -1 +0,0 @@', '-{}',
    'diff --git a/.prism/brief.json b/design/brief.json', 'similarity index 100%', 'rename from .prism/brief.json', 'rename to design/brief.json',
    'diff --git a/.prism/assets.json b/.prism/assets.json', '--- a/.prism/assets.json', '+++ b/.prism/assets.json', '@@ -1 +1 @@', '-[]', '+[{"file":"hero.png"}]',
    'diff --git a/docs/prism/tokens.json b/docs/prism/tokens.json', '--- a/docs/prism/tokens.json', '+++ b/docs/prism/tokens.json', '@@ -1 +1 @@', '-1', '+2',
    'diff --git a/src/app.css b/src/app.css', '--- a/src/app.css', '+++ b/src/app.css', '@@ -1 +1 @@', '-a{}', '+b{}',
  ].join('\n');
  const hits = detect(diff).filter((h) => h.rule === 'visual-contract');
  assert.deepEqual(hits.map((h) => [h.file, h.detail]), [
    ['.prism/tokens.json', 'changed'],
    ['apps/web/.prism/anchors/settings.png', 'changed'],
    ['.prism/dials.json', 'deleted'],
    ['.prism/brief.json', 'renamed to design/brief.json'],
  ]);
  assert.ok(hits.every((h) => allowed(h, ['visual-contract'])), 'the approved look-dev unit allows them all');
  assert.deepEqual(hits.filter((h) => allowed(h, ['visual-contract:apps/web'])).map((h) => h.file), ['apps/web/.prism/anchors/settings.png'], 'or only one folder\'s contract');
});

test('evidence --kind prism checks the report against its tokens and the commit being judged, and a FAIL blocks the pass', () => {
  assert.equal(run('init', 'p1', '--goal', 'a settings screen', '--bar', 'it matches the visual contract', '--fence', 'web/').code, 0);
  run('add', 'p1', 'ui', '--bar', 'the settings screen passes the visual gate');
  run('freeze', 'p1');
  run('start', 'p1', 'ui');
  const building = run('evidence', 'p1', 'ui', '--kind', 'prism', '--file', worktree(report({ head: HEAD2 })), '--label', 'builder self-check');
  assert.equal(building.code, 0, building.err);
  assert.equal(run('built', 'p1', 'ui', '--head', 'aaaaaaaa').code, 0);

  const refused = [
    [worktree(report({ head: HEAD2 })), /the report is for commit bbbbbbbbbbbb, but the build being judged is aaaaaaaa/],
    [worktree(report(), '{"color":{"ink":"#000"}}'), /checked against other tokens/],
    [worktree(report(), null), /no tokens\.json beside the report/],
    [worktree(report({ status: 'PASS', violations: [{ rule: 'raw-colour' }] })), /says PASS but lists 1 fixable violation/],
  ];
  for (const [file, re] of refused) { const r = run('evidence', 'p1', 'ui', '--kind', 'prism', '--file', file); assert.equal(r.code, 1); assert.match(r.err, re); }
  assert.match(run('evidence', 'p1', 'ui', '--kind', 'prism', '--text', 'PASS').err, /--kind prism takes --file/);
  assert.match(run('evidence', 'p1', '--goal', '--kind', 'prism', '--file', worktree(report())).err, /goes on a unit/);

  assert.equal(run('evidence', 'p1', 'ui', '--kind', 'prism', '--file', worktree(failing())).code, 0);
  const blocked = run('verdict', 'p1', 'ui', 'pass', '--evidence', 'the code review is clean', '--score', '9');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /the Prism gate report on this build \(E2\) says FAIL, with 1 finding/);
  assert.equal(run('verdict', 'p1', 'ui', 'fail', '--evidence', 'E2', '--gap', 'a raw colour on the empty state', '--severity', 'medium', '--score', '5').code, 0);

  // Round 2: a new build at a new commit, and the critic's gate passes.
  run('start', 'p1', 'ui');
  run('built', 'p1', 'ui', '--head', HEAD2);
  assert.equal(run('evidence', 'p1', 'ui', '--kind', 'prism', '--file', worktree(report({ head: HEAD2 }))).code, 0);
  const passed = run('verdict', 'p1', 'ui', 'pass', '--evidence', 'E3: the gate passed at bbbbbbb', '--score', '9');
  assert.equal(passed.code, 0, passed.err);

  const items = state('p1').units[0].evidence;
  assert.deepEqual(items.map((e) => [e.kind, e.round, e.prism.status, e.prism.counts]), [['prism', 1, 'PASS', false], ['prism', 1, 'FAIL', true], ['prism', 2, 'PASS', true]]);
  assert.match(items[1].file, /^ui\/E2-gate-report\.json$/, 'the report itself is kept');

  const html = evidenceList(items, null, { artHref: () => null }, 'k');
  assert.match(html, /<span class="chip s-fail">FAIL<\/span> Prism gate at <code>aaaaaaaaaaaa<\/code>, 0 of 1 checks passed/);
  assert.match(html, /<span class="chip s-fail">raw-colour<\/span> settings · empty · 390x844: #3a3a3a in \.card, not a token/);
  assert.match(html, /PASS<\/span> Prism gate at <code>bbbbbbbbbbbb<\/code>, 1 of 1 checks passed<\/p>/);
  assert.match(html, /not the gate: attached while the unit was not being judged/);
  const hostile = evidenceList([{ id: 'E9', kind: 'prism', at: '2026-01-01T00:00:00.000Z', prism: { status: 'FAIL', head: '<b>x</b>', violations: [{ rule: '<script>alert(1)</script>' }, null, 7] } }], null, { artHref: () => null }, 'k');
  assert.ok(!hostile.includes('<script>') && !hostile.includes('<b>x</b>'), 'a hand-edited summary is escaped');
});

test('the prism specialist passes only on a PASS report attached while the unit is judged', () => {
  run('init', 'p2', '--goal', 'a game title screen', '--bar', 'it matches the visual contract', '--fence', 'game/');
  run('add', 'p2', 'title', '--bar', 'the title screen passes the visual gate', '--specialist', 'prism');
  run('freeze', 'p2');
  run('start', 'p2', 'title');
  run('evidence', 'p2', 'title', '--kind', 'prism', '--file', worktree(report()));
  run('built', 'p2', 'title', '--head', HEAD1);
  const early = run('verdict', 'p2', 'title', 'pass', '--specialist', 'prism', '--evidence', 'the builder said it passed', '--score', '9');
  assert.equal(early.code, 1);
  assert.match(early.err, /the prism specialist passes only on a Prism gate report for this build that says PASS/);
  assert.match(run('verdict', 'p2', 'title', 'pass', '--evidence', 'review clean', '--score', '9').err, /specialist prism has not passed this build/);
  run('evidence', 'p2', 'title', '--kind', 'prism', '--file', worktree(report()));
  assert.equal(run('verdict', 'p2', 'title', 'pass', '--specialist', 'prism', '--evidence', 'E2: the gate passed', '--score', '9').code, 0);
  assert.equal(run('verdict', 'p2', 'title', 'pass', '--evidence', 'review clean', '--score', '9').code, 0);
  assert.equal(state('p2').units[0].status, 'pass');
});

test('the gate rules on a unit: the latest judging report decides', () => {
  const item = (id, round, status, counts) => ({ id, kind: 'prism', round, prism: { status, counts, checks: { total: 1, failed: status === 'FAIL' ? 1 : 0 }, violations: [], more: 0 } });
  const u = { rounds: [{ n: 1 }], evidence: [item('E1', 1, 'FAIL', true), item('E2', 2, 'FAIL', true), item('E3', 2, 'PASS', false)] };
  assert.equal(prismGate(u).id, 'E2', 'a report from an earlier round or the building phase does not decide');
  assert.match(prismRefusal(u), /\(E2\) says FAIL, with 1 finding/);
  u.evidence.push(item('E4', 2, 'PASS', true));
  assert.equal(prismRefusal(u), null);
  assert.equal(prismRefusal(u, 'prism'), null);
  assert.equal(prismRefusal({ rounds: [], evidence: [] }), null, 'no report: the unit\'s own critic is not gated');
  assert.match(prismRefusal({ rounds: [], evidence: [] }, 'prism'), /passes only on a Prism gate report/);
  assert.equal(prismRefusal({ rounds: [], evidence: [] }, 'security'), null, 'another specialist is not gated');
});

test('doctor: skip without .prism/, warn without readable tokens or with a committed report, ok otherwise', () => {
  const p = mkdtempSync(join(tmpdir(), 'coordinator-prism-doctor-'));
  try {
    const ctx = { project: p, exec: realExec };
    assert.equal(prismCheck(ctx).status, 'skip');
    mkdirSync(join(p, 'web', '.prism'), { recursive: true });
    const empty = prismCheck(ctx);
    assert.equal(empty.status, 'warn');
    assert.match(empty.text, /web\/\.prism has no readable tokens\.json/);
    writeFileSync(join(p, 'web', '.prism', 'tokens.json'), TOKENS);
    assert.equal(prismCheck(ctx).status, 'ok');
    writeFileSync(join(p, 'web', '.prism', 'gate-report.json'), JSON.stringify(report()));
    const git = (...a) => spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...a], { cwd: p, encoding: 'utf8' });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'contract and a report');
    const tracked = prismCheck(ctx);
    assert.equal(tracked.status, 'warn');
    assert.match(tracked.fix, /git rm --cached web\/\.prism\/gate-report\.json, and add \.prism\/gate-report\.json to \.gitignore/);
  } finally { rmSync(p, { recursive: true, force: true }); }
});
