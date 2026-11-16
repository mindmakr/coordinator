// What precheck and built read from git about a unit's commits: argument arrays only (execFileSync), never a shell
// string, and refs checked first so none is read as an option. Local reads only: no fetch, no network.
import { execFileSync } from 'node:child_process';

const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,200}$/;
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

// The commit a ref names (full sha); throws on a ref that is not one.
export function commitOf(root, ref, name = 'ref') {
  if (typeof ref !== 'string' || !REF.test(ref) || ref.includes('..')) throw new Error(`bad --${name}: ${ref}`);
  try { return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim(); } catch { throw new Error(`--${name} ${ref} is not a commit here`); }
}

// The commit checked out in a folder, and the files not in that commit: changed, added or untracked (what a suite run
// there would test besides the commit). Ignored files (build output, logs) are left out, as git status leaves them.
export const checkedOut = (dir) => git(dir, ['rev-parse', '--verify', 'HEAD']).trim();
export const uncommitted = (dir) => git(dir, ['status', '--porcelain', '-z']).split('\0').filter(Boolean).map((l) => l.slice(3));

// The diff base..head as text (no context lines), and the paths it adds.
export const diffText = (root, base, head) => git(root, ['diff', '--no-color', '--no-ext-diff', '-U0', base, head, '--']);
export const addedFiles = (root, base, head) => git(root, ['diff', '--name-only', '--diff-filter=A', '-z', base, head, '--']).split('\0').filter(Boolean);

// Lines added plus lines removed from base to head (binary files count as one), or null when git cannot say.
export function changedLines(root, base, head) {
  try {
    return git(root, ['diff', '--numstat', '-z', base, head, '--']).split('\0').filter(Boolean)
      .reduce((n, row) => { const [a, d] = row.split('\t'); return n + (a === '-' ? 1 : (Number(a) || 0) + (Number(d) || 0)); }, 0);
  } catch { return null; }
}

// A file's text at a commit, or null when it is not there.
export function fileAt(root, head, path) {
  try { return git(root, ['show', `${head}:${path}`]); } catch { return null; }
}

// Whether any file at head matching pathRe names `word` (a fixed string).
export function namedIn(root, head, word, pathRe) {
  let out = '';
  try { out = git(root, ['grep', '-l', '-F', '-e', word, head, '--']); } catch { return false; } // exit 1: no match
  return out.split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(':') + 1)).some((p) => pathRe.test(p));
}
