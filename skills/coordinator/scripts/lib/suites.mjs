// The lead's full test-suite runs (run.mjs suite). One record per head on the unit, so a critic of that head cites
// it instead of running the suite again (lib/briefs.mjs TESTS_CRITIC), and one full suite per machine at a time:
// a lock in the coordinator's home folder (store.mjs holdLock), because suites run side by side made the load flakes.
import { spawnSync } from 'node:child_process';

export const SHA = /^[0-9a-f]{7,64}$/i;
const KEEP = 10; // records kept per unit

// Two commits are the same head when one names the other: a short sha and its full form.
export const sameHead = (a, b) => typeof a === 'string' && typeof b === 'string' && SHA.test(a) && SHA.test(b)
  && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

// Records one full run on the unit: { head, ok, results (the summary lines), at, by, code?, seconds? }.
export function recordSuite(unit, { head, ok, results, at, by = 'lead', code = null, seconds = null, untracked = [] }) {
  if (!SHA.test(head ?? '')) throw new Error('--head takes the commit the suite ran on (7-64 hex characters)');
  if (!Array.isArray(results) || !results.length) throw new Error('a suite record needs its result line (--result "<the pass line>")');
  const rec = { head: head.toLowerCase(), ok: ok === true, results, at, by, ...(code !== null ? { code } : {}), ...(seconds !== null ? { seconds } : {}), ...(untracked.length ? { untracked: untracked.slice(0, 20) } : {}) };
  unit.suites = [...(unit.suites ?? []), rec].slice(-KEEP);
  return rec;
}

// The latest record for this head, or null.
export const suiteFor = (unit, head) => (head ? [...(unit?.suites ?? [])].reverse().find((r) => sameHead(r.head, head)) ?? null : null);

// The lines of a suite's output worth keeping: its summary (counts of tests, passes, fails), at most `max`, from the end.
export function summaryLines(output, max = 6) {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const counts = lines.filter((l) => /\b(?:tests?|pass(?:ed|ing)?|fail(?:ed|ures?|ing)?|skipped|duration|ok)\b/i.test(l));
  return (counts.length ? counts : lines).slice(-max).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
}

// Runs the suite's command (argv, never a shell string) and returns { code, output, seconds }. On Windows a command
// that is a .cmd or .bat (npm, npx) cannot start without cmd.exe: it is run through cmd.exe /d /c only when every
// argument is a plain word (letters, digits and _ @ + = : , . / \ -), so nothing in it can be read as shell syntax.
// No %: cmd.exe expands %NAME% even inside an argument.
const PLAIN = /^[A-Za-z0-9_@+=:,./\\-]+$/;
export function runSuite(argv, { cwd, env = process.env, spawn = spawnSync, platform = process.platform, now = Date.now } = {}) {
  if (!Array.isArray(argv) || !argv.length || typeof argv[0] !== 'string' || !argv[0]) throw new Error('suite: give the command after --, e.g. run.mjs suite <run> <unit> --head <sha> -- npm test');
  const t0 = now();
  const opts = { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true };
  let r = spawn(argv[0], argv.slice(1), opts);
  if (platform === 'win32' && r.error && ['ENOENT', 'EINVAL'].includes(r.error.code)) {
    if (!argv.every((a) => PLAIN.test(a))) throw new Error(`suite: ${argv[0]} needs cmd.exe on Windows, and an argument is not a plain word; run the test runner directly (node --test …) or record the result with --result`);
    r = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', ...argv], opts);
  }
  if (r.error) throw new Error(`suite: could not start ${argv[0]}: ${r.error.message}`);
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, seconds: Math.round((now() - t0) / 1000) };
}
