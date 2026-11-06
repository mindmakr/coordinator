import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed, detect } from '../lib/gaming.mjs';

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
