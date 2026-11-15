import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowed, detect, installWorktreeHook } from '../lib/gaming.mjs';

const DETECT = fileURLToPath(new URL('../detect.mjs', import.meta.url));

const diff = (path, lines, deleted = false) => [
  `diff --git a/${path} b/${path}`,
  ...(deleted ? ['deleted file mode 100644'] : []),
  `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', ...lines,
].join('\n');
const rules = (d, o) => detect(d, o).map((h) => h.rule);

test('a clean change has no hits', () => {
  assert.deepEqual(rules(diff('src/total.ts', ['-return a', '+return a + b'])), []);
});

test('focused and skipped tests are flagged', () => {
  assert.deepEqual(rules(diff('src/a.test.ts', ['+it.only("x", () => {})'])), ['focused-test']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['+it.skip("x", () => {})'])), ['skipped-test']);
  assert.deepEqual(rules(diff('tests/test_a.py', ['+@pytest.mark.skip'])), ['skipped-test']);
});

test('deleted test files and removed assertions are flagged', () => {
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(x).toBe(1)'], true)), ['test-deleted']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(x).toBe(1)', '-expect(y).toBe(2)', '+expect(x).toBeDefined()'])), ['assertions-removed', 'assertion-weakened']);
});

test('rewritten snapshots, suppressions and ignored failures are flagged', () => {
  assert.deepEqual(rules(diff('src/__snapshots__/a.snap', ['-old', '+new'])), ['snapshot-rewritten']);
  assert.deepEqual(rules(diff('src/a.ts', ['+// @ts-ignore'])), ['check-suppressed']);
  assert.deepEqual(rules(diff('package.json', ['+"test": "vitest run || true"'])), ['failure-ignored']);
});

test('a test renamed to a non-test path counts as deleted', () => {
  const d = ['diff --git a/src/a.test.js b/src/a.test.js.disabled', 'similarity index 100%', 'rename from src/a.test.js', 'rename to src/a.test.js.disabled'].join('\n');
  assert.deepEqual(rules(d), ['test-deleted']);
});

test('CRLF diffs are read the same as LF', () => {
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(x).toBe(1)'], true).replace(/\n/g, '\r\n')), ['test-deleted']);
});

test('more ways to focus or skip are caught', () => {
  for (const line of ['+test.only.each([1])("x", f)', '+it.failing("x", f)', '+    pytest.skip("later")', '+  this.skip()', '+@unittest.skip("x")']) {
    assert.equal(rules(diff('src/a.test.ts', [line])).length, 1, line);
  }
});

test('skipIf and trivialized assertions are caught; "--" lines inside a hunk are content', () => {
  assert.deepEqual(rules(diff('src/a.test.ts', ['+it.skipIf(ci)("x", f)'])), ['skipped-test']);
  assert.deepEqual(rules(diff('tests/test_a.py', ['-assert compute() == 42', '+assert True'])), ['assertion-trivialized']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['--- expect(x).toBe(1) as text', '+expect(x).toBe(1)'])), []);
});

test('more skip forms, test kinds, weakened checks and runner excludes are caught', () => {
  for (const [path, line] of [['src/lib.rs', '+#[ignore]'], ['src/ATest.java', '+@Ignore'], ['tests/ATest.php', '+$this->markTestSkipped("x");'], ['src/a.test.ts', '+it.concurrent.skip("x", f)']]) {
    assert.deepEqual(rules(diff(path, [line])), ['skipped-test'], line);
  }
  assert.deepEqual(rules(diff('cypress/e2e/login.cy.ts', ['-it("x")'], true)), ['test-deleted']);
  assert.deepEqual(rules(diff('spec/user_spec.rb', ['-it "x"'], true)), ['test-deleted']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(total).toBe(42)', '+expect(total).toBeDefined()'])), ['assertion-weakened']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(a).toBe(1); expect(b).toBe(2)', '+expect(a).toBe(1)'])), ['assertions-removed']);
  assert.deepEqual(rules(diff('jest.config.js', ['+  testPathIgnorePatterns: ["totals"],'])), ['tests-excluded']);
});

test('commented-out and dead assertions, common weakenings, suffix-dropping renames', () => {
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(x).toBe(1);', '+// expect(x).toBe(1);'])), ['assertion-commented-out', 'assertions-removed']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['+if (false) expect(x).toBe(1);'])), ['dead-test-code']);
  assert.deepEqual(rules(diff('src/a.test.ts', ['-expect(n).toBe(300)', '+expect(n).toBeGreaterThan(0)'])), ['assertion-weakened']);
  assert.deepEqual(rules(diff('test/a.test.mjs', ['-assert.equal(total, 42)', '+assert.ok(total)'])), ['assertion-weakened']);
  const d = ['diff --git a/tests/b.test.js b/tests/b.js', 'rename from tests/b.test.js', 'rename to tests/b.js'].join('\n');
  assert.deepEqual(rules(d), ['test-deleted']);
});

test('--allow can be scoped to a path', () => {
  const hit = { rule: 'snapshot-rewritten', file: 'src/ui/__snapshots__/a.snap' };
  assert.equal(allowed(hit, ['snapshot-rewritten:src/ui']), true);
  assert.equal(allowed(hit, ['snapshot-rewritten:src/api']), false);
  assert.equal(allowed(hit, ['snapshot-rewritten']), true);
});

test('a fence of "." covers everything', () => {
  assert.deepEqual(rules(diff('docs/a.md', ['+x']), { fence: ['.'] }), []);
});

test('a rename between test names is not a deletion', () => {
  const d = ['diff --git a/src/a.test.js b/src/b.test.js', 'similarity index 100%', 'rename from src/a.test.js', 'rename to src/b.test.js'].join('\n');
  assert.deepEqual(rules(d), []);
});

test('Windows and ./ fence entries match', () => {
  assert.deepEqual(rules(diff('src/x.ts', ['+y']), { fence: ['src\\'] }), []);
  assert.deepEqual(rules(diff('src/x.ts', ['+y']), { fence: ['./src'] }), []);
});

test('files outside the fence are flagged; inside are not', () => {
  const d = diff('docs/readme.md', ['+hello']);
  assert.deepEqual(rules(d, { fence: ['src', 'backend/'] }), ['outside-fence']);
  assert.deepEqual(rules(diff('src/x.ts', ['+y']), { fence: ['src'] }), []);
  assert.deepEqual(rules(diff('srcx/x.ts', ['+y']), { fence: ['src'] }), ['outside-fence']);
});

test('B1: slop detection catches raw useEffect, timer workarounds, cross-boundary imports, and full-file rewrites', () => {
  assert.deepEqual(
    rules(diff('src/components/Panel.tsx', ['+useEffect(() => { load(); }, []);', '+setTimeout(() => retry(), 50);', '+import { db } from "../../backend/db.js";']), { slop: true }),
    ['raw-use-effect', 'timer-workaround', 'cross-boundary-import'],
  );
  // Dedicated hook modules, intra-feature imports, and req.setTimeout are not flagged.
  assert.deepEqual(
    rules(diff('src/hooks/useAuth.ts', ['+useEffect(() => { sync(); }, []);', '+import { api } from "../api.js";']), { slop: true }),
    [],
  );
  assert.deepEqual(rules(diff('src/server/req.ts', ['+req.setTimeout(5000);']), { slop: true }), []);

  const bigRewrite = [
    'diff --git a/src/rewrite.ts b/src/rewrite.ts',
    '--- a/src/rewrite.ts',
    '+++ b/src/rewrite.ts',
    '@@ -1,30 +1,30 @@',
    ...Array.from({ length: 26 }, (_, i) => `-const old${i} = ${i};`),
    ...Array.from({ length: 26 }, (_, i) => `+const next${i} = ${i};`),
  ].join('\n');
  assert.deepEqual(rules(bigRewrite, { slop: true }), ['full-file-rewrite']);
});

test('B2: detect() blocks unauthorized edits to existing test suites while allowing new test files or authorized edits', () => {
  const modExisting = diff('tests/widget.test.js', ['+expect(1).toBe(1);']);
  const newTest = [
    'diff --git a/tests/new_widget.test.js b/tests/new_widget.test.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/tests/new_widget.test.js',
    '@@ -0,0 +1 @@',
    '+expect(1).toBe(1);',
  ].join('\n');

  assert.deepEqual(rules(modExisting, { brief: 'Implement widget formatting in src/widget.ts' }), ['unauthorized-test-edit']);
  assert.deepEqual(rules(newTest, { brief: 'Implement widget formatting in src/widget.ts' }), []);
  assert.deepEqual(rules(modExisting, { brief: 'Fix regression and update existing tests in tests/widget.test.js' }), []);
});

test('B1 + B2 CLI: detect.mjs --hook exits 2 with remediation on stderr; --brief containment rejects traversal and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-gaming-cli-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'coord-outside-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const coordDir = join(dir, '.coordinator');
    mkdirSync(coordDir, { recursive: true });
    const briefFile = join(dir, 'brief.md');
    writeFileSync(briefFile, 'Implement payment retries cleanly in src/pay.ts.');
    const badDiff = join(dir, 'bad.diff');
    writeFileSync(badDiff, [
      diff('src/frontend/Pay.tsx', ['+setTimeout(() => submit(), 100);', '+import { secretDb } from "../../backend/db.js";']),
      diff('tests/pay.test.js', ['+assert.equal(1, 1);']),
    ].join('\n'));

    const r = spawnSync(
      process.execPath,
      [DETECT, '--hook', '--diff-file', badDiff, '--brief', briefFile, '--fence', 'src,tests'],
      { cwd: dir, env: { ...process.env, COORDINATOR_DIR: coordDir }, encoding: 'utf8' },
    );
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.clean, false);
    assert.deepEqual(out.hits.map((h) => h.rule), ['timer-workaround', 'cross-boundary-import', 'unauthorized-test-edit']);
    assert.match(r.stderr, /BLOCKED \(exit code 2\)/);
    assert.match(r.stderr, /timer-workaround/);
    assert.match(r.stderr, /unauthorized-test-edit/);

    const cleanDiff = join(dir, 'clean.diff');
    writeFileSync(cleanDiff, diff('src/pay.ts', ['-return 1;', '+return 2;']));
    const okRun = spawnSync(
      process.execPath,
      [DETECT, '--hook', '--diff-file', cleanDiff, '--brief', briefFile, '--fence', 'src'],
      { cwd: dir, env: { ...process.env, COORDINATOR_DIR: coordDir }, encoding: 'utf8' },
    );
    assert.equal(okRun.status, 0);

    // Path traversal outside allowed roots must be rejected with exit code 2.
    const outsideBrief = join(outsideDir, 'leak.md');
    writeFileSync(outsideBrief, 'allow-test-edit');
    const escRun = spawnSync(
      process.execPath,
      [DETECT, '--hook', '--diff-file', cleanDiff, '--brief', outsideBrief],
      { cwd: dir, env: { ...process.env, COORDINATOR_DIR: coordDir }, encoding: 'utf8' },
    );
    assert.equal(escRun.status, 2);
    assert.match(escRun.stderr, /escapes allowed project root/);

    // Symlink brief rejection when symlink creation is permitted on the host OS.
    const linkBrief = join(dir, 'link.md');
    let symlinkCreated = false;
    try { symlinkSync(briefFile, linkBrief); symlinkCreated = true; } catch { /* unprivileged Windows */ }
    if (symlinkCreated) {
      const symRun = spawnSync(
        process.execPath,
        [DETECT, '--hook', '--diff-file', cleanDiff, '--brief', linkBrief],
        { cwd: dir, env: { ...process.env, COORDINATOR_DIR: coordDir }, encoding: 'utf8' },
      );
      assert.equal(symRun.status, 2);
      assert.match(symRun.stderr, /regular file, not a symlink/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('installWorktreeHook merges .claude/settings.local.json idempotently and excludes it in git', () => {
  const wt = mkdtempSync(join(tmpdir(), 'coord-hook-wt-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: wt });
    mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2));

    const first = installWorktreeHook(wt, { detectScriptPath: DETECT });
    assert.equal(first.ok, true);
    assert.equal(first.added, true);
    assert.ok(existsSync(first.settingsPath));
    const saved = JSON.parse(readFileSync(first.settingsPath, 'utf8'));
    assert.deepEqual(saved.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(saved.hooks.Stop.length, 1);
    assert.match(saved.hooks.Stop[0].hooks[0].command, /detect\.mjs.*--hook/);

    const second = installWorktreeHook(wt, { detectScriptPath: DETECT });
    assert.equal(second.added, false);
    const savedAgain = JSON.parse(readFileSync(first.settingsPath, 'utf8'));
    assert.equal(savedAgain.hooks.Stop.length, 1);

    const exclude = readFileSync(join(wt, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /\.claude\/settings\.local\.json/);

    assert.throws(() => installWorktreeHook(resolve(homedir())), /home directory/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
