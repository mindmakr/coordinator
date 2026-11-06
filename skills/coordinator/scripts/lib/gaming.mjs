// Deterministic checks for a diff that games the bar instead of meeting it.
// Pure: takes unified-diff text, returns hits. No model, no network.

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|cypress)\/|\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$|_(test|spec)\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|php|swift)$/;
const SNAPSHOT = /(__snapshots__\/|\.snap$)/;
// Test-runner configs: an added ignore/exclude entry hides tests from the run.
const RUNNER_CONFIG = /(^|\/)((jest|vitest|playwright|cypress|karma|mocha|ava)\.config\.[cm]?[jt]s|\.mocharc\.\w+|pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml|phpunit\.xml(\.dist)?|package\.json)$/;
const RUNNER_IGNORE = /testPathIgnorePatterns|modulePathIgnorePatterns|testIgnore|exclude|excludeSpecPattern|--ignore|--deselect|norecursedirs|addopts\s*=.*(-k\s|--ignore|--deselect)|<exclude>|"skip"/;

const ADDED = [
  { rule: 'focused-test', re: /\b(it|test|describe)(\.\w+)*\.only\b|\bf(it|describe)\s*\(/ },
  { rule: 'skipped-test', re: /\b(it|test|describe)(\.\w+)*\.(skip|skipIf|todo|failing)\b|\bx(it|describe|test)\s*\(|\bpytest\.(mark\.)?(skip|xfail)\b|\bunittest\.skip|\bthis\.skip\(\)|\bt\.Skip(Now|f)?\(|@(Disabled|Ignore)\b|\[Ignore\]|#\[ignore\]|markTestSkipped|markTestIncomplete|\bskip\s*:\s*true\b|\bpending\s*\(/ },
  { rule: 'check-suppressed', re: /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|@SuppressWarnings|#\s*pragma:\s*no cover|#\[allow\(/ },
  { rule: 'failure-ignored', re: /\|\|\s*true\b|continue-on-error:\s*true|--passWithNoTests|--no-verify|allow_failure:\s*true/ },
  { rule: 'dead-test-code', re: /\bif\s*\(\s*(false|0)\s*\)|\bif\s+False\s*:/ },
];
const COMMENTED_ASSERT = /^\s*(\/\/|#|\/\*|\*)\s*(expect|assert\w*|should)\b/;
const stripComment = (l) => (/^\s*(\/\/|#|\/\*|\*)/.test(l) ? '' : l.replace(/\s\/\/.*$/, ''));
// Counted per occurrence, not per line: "expect(a); expect(b)" is two.
const ASSERT = /\b(expect|assert\w*|should)\s*[.(]|(^|;)\s*assert\s/g;
const TRIVIAL = /^\s*assert\s+True\b|expect\(\s*true\s*\)\.toBe(Truthy)?\(\s*(true)?\s*\)|assert\.ok\(\s*true\s*\)|assertTrue\(\s*true\s*\)/;
// Exact matchers swapped for ones that accept almost anything.
const STRICT = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toThrow\w*|toHaveBeenCalledWith)\(\s*[^)\s]|assertEquals?\(|assert\.(equal|strictEqual|deepEqual|deepStrictEqual)\(|assert\s+\S+\s*==/g;
const LOOSE = /\.(toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined|toBeTypeOf|toBeInstanceOf|toBeGreaterThan|toBeLessThan|toBeGreaterThanOrEqual)\(|\.toThrow\(\s*\)|expect\.any(thing)?\(|assert\.ok\(|assertIsNotNone|assert\s+\S+\s*(is not None)?\s*$/g;

// Comments are not checks: a commented-out assertion counts as removed.
const count = (lines, re) => lines.reduce((n, l) => n + (stripComment(l).match(re)?.length ?? 0), 0);

export function parseDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = { path: m ? m[2] : line, deleted: false, renamedFrom: null, inHunk: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('@@')) cur.inHunk = true;
    else if (!cur.inHunk) {
      // Header lines only: inside a hunk, "--- x" is a removed line, not a header.
      if (line.startsWith('deleted file mode')) cur.deleted = true;
      else if (line.startsWith('rename from ')) cur.renamedFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    }
    else if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

// Fence entries are path prefixes; Windows separators, ./ and . are normalised.
const clean = (p) => p.replace(/\\/g, '/').replace(/^\.(\/|$)/, '').replace(/\/+$/, '');
const inFence = (path, fence) => !fence.length || fence.map(clean).some((p) => p === '' || path === p || path.startsWith(`${p}/`));

export function detect(diff, { fence = [] } = {}) {
  const hits = [];
  const hit = (rule, file, detail) => hits.push(detail === undefined ? { rule, file } : { rule, file, detail });
  for (const f of parseDiff(diff)) {
    const isTest = TEST_FILE.test(f.path);
    if (f.deleted && isTest) hit('test-deleted', f.path);
    const dropsSuffix = f.renamedFrom && /\.(test|spec|cy)\./.test(f.renamedFrom) && !/\.(test|spec|cy)\./.test(f.path);
    if (f.renamedFrom && TEST_FILE.test(f.renamedFrom) && (!isTest || dropsSuffix)) hit('test-deleted', f.renamedFrom, `renamed to ${f.path}`);
    if (SNAPSHOT.test(f.path) && f.removed.length) hit('snapshot-rewritten', f.path, `${f.removed.length} lines replaced`);
    if (!inFence(f.path, fence)) hit('outside-fence', f.path);
    if (RUNNER_CONFIG.test(f.path)) for (const t of f.added) if (RUNNER_IGNORE.test(t)) hit('tests-excluded', f.path, t.trim().slice(0, 160));
    for (const t of f.added) for (const { rule, re } of ADDED) if (re.test(t)) hit(rule, f.path, t.trim().slice(0, 160));
    if (!isTest || f.deleted) continue;
    for (const t of f.added) if (COMMENTED_ASSERT.test(t)) hit('assertion-commented-out', f.path, t.trim().slice(0, 160));
    const trivial = f.added.filter((t) => TRIVIAL.test(t));
    for (const t of trivial) hit('assertion-trivialized', f.path, t.trim().slice(0, 160));
    const net = count(f.added, ASSERT) - count(f.removed, ASSERT);
    if (net < 0) hit('assertions-removed', f.path, `net ${net}`);
    const strictLost = count(f.removed, STRICT) - count(f.added, STRICT);
    const looseGained = count(f.added.filter((t) => !TRIVIAL.test(t)), LOOSE) - count(f.removed, LOOSE);
    if (strictLost > 0 && looseGained > 0) hit('assertion-weakened', f.path, `${strictLost} exact check(s) replaced by looser ones`);
  }
  return hits;
}

// --allow takes "rule" (anywhere) or "rule:path-prefix" (only there).
export function allowed(hit, allow) {
  return allow.some((a) => {
    const [rule, path] = a.split(/:(.*)/s);
    return rule === hit.rule && (!path || hit.file === clean(path) || hit.file.startsWith(`${clean(path)}/`));
  });
}
