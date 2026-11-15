// Deterministic checks for a diff that games the bar instead of meeting it,
// unauthorized edits to existing test files, hunk-level slop checks (#162),
// bounded brief reading, and worktree Stop hook installation.
// Pure diff/rule logic + filesystem helpers; no model, no network.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excludeLine } from './prefix.mjs';
import { detectLineSlop } from './quality/slop.mjs';
import { readBoundedFile } from './statechart.mjs';
import { writeJson } from './store.mjs';

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|cypress)\/|\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$|_(test|spec)\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|php|swift)$/;
const SNAPSHOT = /(__snapshots__\/|\.snap$)/;
// Test-runner configs: an added ignore/exclude entry hides tests from the run.
const RUNNER_CONFIG = /(^|\/)((jest|vitest|playwright|cypress|karma|mocha|ava)\.config\.[cm]?[jt]s|\.mocharc\.\w+|pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml|phpunit\.xml(\.dist)?|package\.json)$/;
const RUNNER_IGNORE = /testPathIgnorePatterns|modulePathIgnorePatterns|testIgnore|exclude|excludeSpecPattern|--ignore|--deselect|norecursedirs|addopts\s*=.*(-k\s|--ignore|--deselect)|<exclude>|"skip"/;
// The visual contract (references/prism.md): Prism's brief, dials, tokens and anchors, in any folder's .prism/.
// A build treats it as read-only, so a build cannot loosen the look to pass the gate. Only the look-dev
// unit the person approved changes it, and the lead allows that with --allow visual-contract.
const VISUAL_CONTRACT = /(^|\/)\.prism\/(brief\.json|dials\.json|tokens\.json|anchors\/.+)$/;

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
      cur = { path: m ? m[2] : line, isNew: false, deleted: false, renamedFrom: null, inHunk: false, hunks: 0, firstOldStart: null, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('@@')) {
      cur.inHunk = true;
      cur.hunks += 1;
      const hm = /^@@ -(\d+)/.exec(line);
      if (hm && cur.firstOldStart === null) cur.firstOldStart = Number(hm[1]);
    } else if (!cur.inHunk) {
      // Header lines only: inside a hunk, "--- x" is a removed line, not a header.
      if (line.startsWith('deleted file mode')) cur.deleted = true;
      else if (line.startsWith('new file mode ') || line === '--- /dev/null') cur.isNew = true;
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

const TEST_AUTH_PHRASE = /\ballow-test-edit\b|\b(?:modify|update|edit|change|fix|rewrite|adjust|refactor|adapt|extend)\s+(?:the\s+)?(?:existing\s+)?(?:tests?|specs?|test suites?)\b|\b(?:existing\s+)?(?:tests?|specs?|test suites?)\s+(?:may|should|must|can|to)\s+be\s+(?:modified|updated|edited|changed|fixed|rewritten|adjusted)\b/i;

// True when a brief or unit explicitly authorizes modifying existing tests (or names the file).
export function isTestEditAuthorized({ brief = null, unit = null, file = '' } = {}) {
  const normFile = clean(String(file ?? ''));
  const base = normFile ? basename(normFile) : '';
  const unitText = unit ? [
    unit.title,
    unit.bar,
    ...(unit.behaviours ?? []).map((b) => b?.text ?? ''),
    ...(unit.notes ?? []).filter((n) => n?.kind === 'person' || n?.kind === 'decision').map((n) => n?.text ?? ''),
  ].filter(Boolean).join('\n') : '';
  const scopeText = brief !== null && brief !== undefined ? String(brief) : unitText;
  if (TEST_AUTH_PHRASE.test(scopeText)) return true;
  if (normFile && (scopeText.includes(normFile) || (base && scopeText.includes(base)))) return true;
  if ((brief === null || brief === undefined) && normFile && Array.isArray(unit?.touches) && unit.touches.some((t) => clean(String(t)) === normFile)) {
    return true;
  }
  return false;
}

export function detect(diff, { fence = [], brief = null, unit = null, enforceTestScope = false, slop = false } = {}) {
  const hits = [];
  const hit = (rule, file, detail) => hits.push(detail === undefined ? { rule, file } : { rule, file, detail });
  const checkTestScope = Boolean(enforceTestScope || brief !== null || unit !== null);
  for (const f of parseDiff(diff)) {
    const isTest = TEST_FILE.test(f.path);
    if (f.deleted && isTest) hit('test-deleted', f.path);
    const dropsSuffix = f.renamedFrom && /\.(test|spec|cy)\./.test(f.renamedFrom) && !/\.(test|spec|cy)\./.test(f.path);
    if (f.renamedFrom && TEST_FILE.test(f.renamedFrom) && (!isTest || dropsSuffix)) hit('test-deleted', f.renamedFrom, `renamed to ${f.path}`);
    if (SNAPSHOT.test(f.path) && f.removed.length) hit('snapshot-rewritten', f.path, `${f.removed.length} lines replaced`);
    if (!inFence(f.path, fence)) hit('outside-fence', f.path);
    if (f.renamedFrom && VISUAL_CONTRACT.test(f.renamedFrom)) hit('visual-contract', f.renamedFrom, `renamed to ${f.path}`);
    else if (VISUAL_CONTRACT.test(f.path)) hit('visual-contract', f.path, f.deleted ? 'deleted' : 'changed');
    if (RUNNER_CONFIG.test(f.path)) for (const t of f.added) if (RUNNER_IGNORE.test(t)) hit('tests-excluded', f.path, t.trim().slice(0, 160));
    for (const t of f.added) for (const { rule, re } of ADDED) if (re.test(t)) hit(rule, f.path, t.trim().slice(0, 160));

    if (checkTestScope && isTest && !f.isNew && !f.deleted && (f.added.length > 0 || f.removed.length > 0)) {
      if (!isTestEditAuthorized({ brief, unit, file: f.path })) {
        hit('unauthorized-test-edit', f.path, 'existing test modified without authorization in unit brief');
      }
    }

    if (slop && !isTest && !f.deleted) {
      for (const t of f.added) {
        for (const s of detectLineSlop(t, f.path)) {
          hit(s.kind, f.path, String(s.detail).slice(0, 160));
        }
      }
      if (!f.isNew && f.hunks === 1 && (f.firstOldStart ?? 1) <= 2 && f.removed.length >= 25 && f.added.length >= 25) {
        hit('full-file-rewrite', f.path, `${f.removed.length} lines removed and ${f.added.length} added in 1 hunk`);
      }
    }

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

const RULE_FIX = {
  'timer-workaround': 'Remove setTimeout/setInterval/rAF delay workarounds and synchronize on real state or events instead.',
  'raw-use-effect': 'Move raw useEffect logic into a dedicated hook module or derive state directly.',
  'cross-boundary-import': 'Import through the public module boundary instead of deep or cross-layer relative paths.',
  'unauthorized-test-edit': 'Revert edits to existing test files unless explicitly authorized by the unit brief; add new tests for new behaviour.',
  'full-file-rewrite': 'Replace the wholesale rewrite with minimal, targeted hunks.',
};

// Formats actionable stderr guidance when the exit-code-2 lifecycle hook rejects a diff.
export function formatHookRemediation(hits) {
  const lines = ['BLOCKED (exit code 2): pre-gate detected bar-gaming or code slop. Fix the root cause before finishing:'];
  for (const h of hits) {
    const hint = RULE_FIX[h.rule] ?? 'Fix the underlying root cause cleanly rather than suppressing or weakening checks.';
    lines.push(`- [${h.rule}] ${h.file}${h.detail ? ` (${h.detail})` : ''}: ${hint}`);
  }
  return lines.join('\n');
}

// Safely reads a bounded unit brief file inside allowed project/worktree/state roots (no symlinks or traversal).
export function readBriefFile(rawPath, { baseDir, allowedRoots } = {}) {
  return readBoundedFile(rawPath, { flag: '--brief', maxBytes: 256 * 1024, baseDir, allowedRoots });
}

// Installs or updates a worktree Stop hook in `.claude/settings.local.json` that runs `detect.mjs --hook`
// and excludes `.claude/settings.local.json` via `.git/info/exclude`. Never touches ~/.claude.
export function installWorktreeHook(worktreeRoot, { detectScriptPath = fileURLToPath(new URL('../detect.mjs', import.meta.url)), exec = execFileSync } = {}) {
  const root = resolve(String(worktreeRoot ?? ''));
  if (!root || root === resolve(homedir())) throw new Error('refusing to install worktree hook into home directory');
  let lst;
  try { lst = lstatSync(root); } catch { throw new Error(`worktree root does not exist: ${worktreeRoot}`); }
  if (lst.isSymbolicLink() || !statSync(root).isDirectory()) throw new Error(`worktree root must be a real directory: ${worktreeRoot}`);

  const claudeDir = join(root, '.claude');
  if (existsSync(claudeDir) && lstatSync(claudeDir).isSymbolicLink()) throw new Error('.claude must not be a symlink');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.local.json');
  let current = {};
  if (existsSync(settingsPath)) {
    const sst = lstatSync(settingsPath);
    if (sst.isSymbolicLink() || !sst.isFile()) throw new Error(`${settingsPath} must be a regular file`);
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${settingsPath} must be a JSON object`);
    current = parsed;
  }

  const command = `node ${JSON.stringify(resolve(detectScriptPath))} --hook`;
  const hooks = current.hooks && typeof current.hooks === 'object' && !Array.isArray(current.hooks) ? { ...current.hooks } : {};
  const stopList = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  const alreadyInstalled = stopList.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => String(h?.command ?? '').includes('detect.mjs') && String(h?.command ?? '').includes('--hook')));
  if (!alreadyInstalled) {
    stopList.push({ hooks: [{ type: 'command', command }] });
  }
  hooks.Stop = stopList;
  const nextSettings = { ...current, hooks };
  writeJson(settingsPath, nextSettings);

  try {
    const git = (args) => exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const exclude = resolve(root, git(['rev-parse', '--git-path', 'info/exclude']).trim());
    const line = excludeLine(git(['rev-parse', '--show-prefix']).trim());
    const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    mkdirSync(dirname(exclude), { recursive: true });
    const bare = line.replace(/^\//, '');
    const same = new Set([line, bare, `/${bare}`]);
    if (!existing.split(/\r?\n/).some((l) => same.has(l.trim()))) {
      appendFileSync(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`);
    }
  } catch { /* not a git repo */ }

  return { ok: true, settingsPath, command, added: !alreadyInstalled };
}
