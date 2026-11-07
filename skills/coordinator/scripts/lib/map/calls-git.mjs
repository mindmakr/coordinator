// Git reads for the call index (lib/map/calls.mjs), all read-only: a ref to its
// commit, a commit's file list with blob ids, blob contents in one batch, and
// the lines a diff changed. A blob id is also the scan cache's key, so a file
// read from the working tree hashes the way git does.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const git = (root, args, opts = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 29, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], ...opts });

// Git's id for a blob with these bytes.
export const blobId = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// The commit a ref names, or null (unknown ref, not a repo). A ref is never read as an option.
export function commitOf(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /\s/.test(ref)) return null;
  try { return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

// Every file in a commit: path → blob id.
export function treeOf(root, commit) {
  const out = new Map();
  for (const e of git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: 'utf8' }).split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(e);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// Blob contents by id, in batches of one git call each: array of utf-8 text (null when missing).
export function blobs(root, ids, batch = 400) {
  const out = [];
  for (let i = 0; i < ids.length; i += batch) {
    const part = ids.slice(i, i + batch);
    const buf = git(root, ['cat-file', '--batch'], { input: part.map((id) => `${id}\n`).join('') });
    let at = 0;
    for (let k = 0; k < part.length; k++) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) { out.push(null); continue; }
      const head = buf.toString('utf8', at, nl).split(' ');
      at = nl + 1;
      if (head[1] !== 'blob') { out.push(null); continue; } // "<id> missing"
      const size = Number(head[2]);
      out.push(buf.toString('utf8', at, at + size));
      at += size + 1;
    }
  }
  return out;
}

// The lines each file gained or changed between two commits: file → [[from, to]] in the head's numbering.
export function diffRanges(root, base, head, keep = () => true) {
  const out = git(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--unified=0', '-M', `${base}...${head}`, '--'], { encoding: 'utf8' });
  const files = new Map(); let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) { const p = line.slice(4).trim(); cur = p === '/dev/null' ? null : p.replace(/^b\//, ''); if (cur && keep(cur)) files.set(cur, []); else cur = null; continue; }
    const h = cur && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { const a = Number(h[1]); const n = h[2] === undefined ? 1 : Number(h[2]); files.get(cur).push(n ? [a, a + n - 1] : [a, a]); }
  }
  return files;
}
