// The project's files, relative with forward slashes: git's own list when the
// root is in a repo (tracked plus untracked, minus ignored), else a walk.
// Build output, dependencies and hidden folders never count.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'bin', 'obj', '__pycache__', 'venv', 'Pods', 'DerivedData']);
const skipped = (rel) => rel.split('/').some((p, i, all) => i < all.length - 1 && (SKIP.has(p) || (p.startsWith('.') && p !== '.')));

export const JS = /\.(?:[cm]?[jt]sx?)$/;
export const OTHER = /\.(?:py|go|rs|java|kt|kts|rb|php|c|cc|cpp|cxx|h|hpp|cs|dart|swift|scala|ex|exs)$/;
// Env files hold secrets: only the documented templates are ever listed (and read for key names).
const ignoredFile = (f) => /\.d\.[cm]?ts$|\.min\.js$/.test(f) || (/(^|\/)\.env(\.|$)/.test(f) && !ENV_TEMPLATE.test(f));
export const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/;

function walk(root, rel = '', out = [], deadline = Infinity) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (Date.now() > deadline || out.length > 200_000) break;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(root, p, out, deadline); } else if (e.isFile()) out.push(p);
  }
  return out;
}

export function listFiles(root, deadline = Infinity) {
  let files;
  try {
    const raw = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    files = raw.split('\0').filter(Boolean);
  } catch { files = []; }
  if (!files.length) files = walk(root, '', [], deadline); // not a repo, or a folder git ignores
  return [...new Set(files)].filter((f) => !skipped(f) && !ignoredFile(f)).sort();
}

// HEAD's commit and whether a remote branch has it (so a GitHub link to it works).
export function gitHead(root) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const commit = git('rev-parse', 'HEAD');
    let pushed = false;
    try { pushed = git('branch', '-r', '--contains', commit).length > 0; } catch { /* no remotes */ }
    return { commit, pushed };
  } catch { return { commit: null, pushed: false }; }
}
