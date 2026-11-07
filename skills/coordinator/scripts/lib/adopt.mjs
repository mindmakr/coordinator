// Files a run mentions by path (in reports, verdicts, notes, evidence text)
// often live in a worktree or a scratch folder that is deleted after the run.
// `adopt` copies each one that still exists into the run folder through the
// same checked code as `evidence --file`, as evidence of the unit that names it
// (run-level mentions go to the goal's evidence). The text stays as written;
// the stored copy is what the HUD shows. Adopting twice changes nothing, except
// that a stored copy found missing or changed is copied again from its source.
// Only files under the allowed roots are copied: the project, its worktrees,
// the OS temp folder and the coordinator's state folder. Never the person's
// home configuration (~/.claude*, ~/.ssh, ~/.aws, AppData/Roaming, …).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { DOC, GOAL_DIR, IMAGE, LIMITS, TEXT, addEvidence, copyIn, sha256 } from './evidence.mjs';

export const RUN_CAP = 50 * 1024 * 1024; // all adopted files of one run together
const EXT = [...Object.keys(IMAGE), ...Object.keys(TEXT), ...Object.keys(DOC)].map((e) => e.slice(1)).join('|');
const ENDS = new RegExp(`\\.(?:${EXT})(?![A-Za-z0-9])`, 'gi');
const ENDS_AT_END = new RegExp(`\\.(?:${EXT})$`, 'i');
const QUOTED = /(["'`])([^"'`\n]{3,300}?)\1/g;
const BOUNDARY = /[\s"'`([{<,;=]/;
const ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/;
const SEP = /[\\/]/;
// Never copied: secrets and key material, whatever their extension says.
const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*credentials.*|.*secret.*|\.npmrc|\.netrc)$/i;
// Fields that hold stored names, ids or links rather than prose.
const SKIP = new Set(['file', 'sha256', 'source', 'url', 'id', 'at', 'type', 'kind', 'bytes', 'label', 'behaviour']);

const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const same = (a, b) => key(a) === key(b);
const inside = (dir, p) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// Paths in a piece of text: [{ raw, unclear }]. Quoted paths are taken whole.
// Unquoted ones may hold spaces or brackets ("C:/Users/John Smith/shot (1).png"):
// the longest reading that names an existing file wins; when none does and a
// reading with spaces could have been meant, the mention is marked unclear.
// URLs are blanked first so their paths do not count.
export function pathsIn(text, exists = () => false, folderExists = () => false) {
  let t = String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (u) => ' '.repeat(u.length));
  const out = [];
  t = t.replace(QUOTED, (all, q, body) => {
    if (ENDS_AT_END.test(body) && SEP.test(body)) { out.push({ raw: body, unclear: false }); return ' '.repeat(all.length); }
    return all;
  });
  for (const m of t.matchAll(ENDS)) {
    const end = m.index + m[0].length;
    const line = t.lastIndexOf('\n', m.index) + 1;
    const reads = [];
    for (let s = m.index; s >= Math.max(line, end - 300); s--) {
      if (s !== line && !BOUNDARY.test(t[s - 1])) continue;
      const c = t.slice(s, end).replace(/^[([{<]+/, '');
      if (SEP.test(c) && !BOUNDARY.test(c[0] ?? ' ')) reads.push(c);
    }
    if (!reads.length) continue;
    const found = [...reads].reverse().find((c) => exists(c));
    if (found) { out.push({ raw: found, unclear: false }); continue; }
    const plain = reads.find((c) => !/[\s()[\],;]/.test(c));
    // A reading with spaces that holds another file name ("a.txt (b.md") is two mentions, not one path.
    // Prose that happens to start with / ("/map 500 without reason; … (map.json") is not a path: a
    // reading with spaces counts only when it starts with a drive letter or ~, or its folder exists.
    const spaced = reads.filter((c) => (/^([A-Za-z]:[\\/]|~[\\/])/.test(c) || folderExists(c)) && /[\s()[\],;]/.test(c) && !new RegExp(ENDS.source, 'i').test(c.slice(0, -m[0].length)));
    if (plain && ABSOLUTE.test(plain)) out.push({ raw: plain.replace(/[.:]+$/, ''), unclear: false });
    else if (spaced.length) out.push({ raw: spaced[0], unclear: true });
    else if (plain) out.push({ raw: plain, unclear: false });
  }
  return out;
}

// Resolves a mention; Git Bash's /c/Users/... becomes C:/Users/... on Windows.
export function resolveMention(p, project, home) {
  if (p.startsWith('~')) return resolve(home, p.slice(2));
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(p)) return resolve(`${p[1].toUpperCase()}:${p.slice(2)}`);
  return isAbsolute(p) ? resolve(p) : resolve(project, p);
}

// Every mention in the state: [{ path, target, unclear }], first mention wins.
export function mentions(s, { project, home }) {
  const found = new Map();
  const at = (raw) => resolveMention(raw, project, home);
  const visit = (v, target) => {
    if (typeof v === 'string') {
      const isFile = (c) => { try { return statSync(at(c)).isFile(); } catch { return false; } };
      // The folder must be more than a drive or filesystem root: '/ move cards … (x.json' is prose.
      const isFolder = (c) => { const d = dirname(at(c)); try { return parse(d).root !== d && statSync(d).isDirectory(); } catch { return false; } };
      for (const { raw, unclear } of pathsIn(v, isFile, isFolder)) {
        const r = at(raw);
        if (!found.has(key(r))) found.set(key(r), { path: r, target, unclear });
      }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, target); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP.has(k)) visit(x, k === 'units' ? null : target);
  };
  for (const u of s.units ?? []) visit(u, u.id);
  for (const n of s.notes ?? []) visit(n, n.unit && (s.units ?? []).some((u) => u.id === n.unit) ? n.unit : GOAL_DIR);
  const { units, notes, ...rest } = s;
  visit(rest, GOAL_DIR);
  return [...found.values()];
}

const stored = (s) => [...(s.goalEvidence ?? []).map((e) => [e, null]), ...(s.units ?? []).flatMap((u) => (u.evidence ?? []).map((e) => [e, u]))].filter(([e]) => e.file);

// Where adopt may copy from: the project, its git worktrees, the OS temp folder and the state folder.
// A root that is the home folder or holds it (COORDINATOR_DIR=~, say) is left out:
// it would let every file under home through.
export function allowedRoots(project, base, home) {
  const roots = [project, tmpdir(), base];
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const l of out.split('\n')) if (l.startsWith('worktree ')) roots.push(resolve(l.slice(9).trim()));
  } catch { /* not a repo */ }
  return roots.map((r) => resolve(r)).filter((r) => !home || !inside(r, resolve(home)));
}

// The person's own configuration under their home folder.
export function homeConfig(p, home) {
  if (!home || !inside(home, p)) return false;
  const parts = relative(home, p).split(/[\\/]+/);
  return parts[0].startsWith('.') || (parts[0].toLowerCase() === 'appdata' && (parts[1] ?? '').toLowerCase() === 'roaming');
}

// Why a path may not be copied, or null.
export function refusal(p, { home, roots, project } = {}) {
  const parts = p.split(/[\\/]+/);
  if (parts.some((x) => x === 'node_modules' || x === '.git')) return 'inside node_modules or .git';
  if (SECRET.test(basename(p))) return 'looks like a secret or key file';
  if (homeConfig(p, home)) return 'in your home configuration folders';
  if (roots && !roots.some((r) => inside(r, p))) return 'outside allowed roots (project, worktrees, temp, state folder)';
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return 'a symbolic link';
  if (st.nlink > 1 && !(project && inside(project, p))) return 'a hard link (outside the project)';
  if (!st.isFile()) return 'not a regular file';
  try { if (!same(realpathSync.native(p), p)) return 'reached through a link'; } catch { return 'unreadable'; }
  return null;
}

// Files git tracks in the project: they survive in history, so they are not adopted.
export function trackedFiles(project) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
    return new Set(out.split('\0').filter(Boolean).map((f) => key(resolve(project, f))));
  } catch { return new Set(); }
}

const damage = (e, runDir) => {
  let buf;
  try { buf = readFileSync(join(runDir, 'artifacts', ...e.file.split('/'))); } catch { return 'missing'; }
  return e.sha256 && sha256(buf) !== e.sha256 ? 'changed (sha256 mismatch)' : null;
};
const kindOf = (ext) => (IMAGE[ext] ? 'screenshot' : DOC[ext] ? 'pdf' : 'log');

// Classifies every mention, and with apply=true copies the adoptable ones into
// the state. Rows: { path, unit, status, why?, evidence? }; status is adopted
// (adoptable on a dry run), already, repaired (repairable), inside (the run
// folder), tracked (in git), missing, unclear or refused.
export function adopt(s, runDir, { project, home, apply = false, tracked = trackedFiles(project), roots = allowedRoots(project, dirname(dirname(runDir)), home) }) {
  const rows = [];
  const have = stored(s);
  // Adopted before pdf was a kind: show those PDFs as PDFs.
  if (apply) for (const [e] of have) if (e.source && e.type === 'doc' && e.kind === 'log') e.kind = 'pdf';
  let total = have.reduce((n, [e]) => n + (e.source ? (e.bytes ?? 0) : 0), 0);
  for (const { path, target, unclear } of mentions(s, { project, home })) {
    const row = { path, unit: target };
    rows.push(row);
    if (inside(runDir, path)) { row.status = 'inside'; continue; }
    if (tracked.has(key(path))) { row.status = 'tracked'; continue; }
    const prior = have.find(([e]) => e.source && same(e.source, path))?.[0];
    if (unclear && !prior && !existsSync(path)) {
      row.status = 'unclear'; row.why = 'not found, and spaces or brackets make the path uncertain; quote it, or attach it with evidence --file';
      continue;
    }
    const why = refusal(path, { home, roots, project });
    if (prior) {
      row.evidence = prior.file;
      const bad = damage(prior, runDir);
      if (!bad) { row.status = 'already'; continue; }
      if (why || !existsSync(path)) { row.status = 'refused'; row.why = `stored copy ${bad}; the source ${why ?? 'is gone'}`; continue; }
      if (!apply) { row.status = 'repairable'; row.why = `stored copy ${bad}`; continue; }
      try {
        const again = copyIn(path, runDir, prior.file.split('/')[0], prior.id);
        Object.assign(prior, { file: again.file, sha256: again.sha256, bytes: again.bytes });
        row.status = 'repaired'; row.evidence = prior.file;
      } catch (e) { row.status = 'refused'; row.why = e.message.replace(/^--file /, ''); }
      continue;
    }
    if (why) { row.status = 'refused'; row.why = why; continue; }
    if (!existsSync(path)) { row.status = 'missing'; continue; }
    const size = statSync(path).size;
    const ext = extname(path).toLowerCase();
    const cap = TEXT[ext] ? LIMITS.textFile : LIMITS.image;
    if (size > cap) { row.status = 'refused'; row.why = `over the ${Math.round(cap / 1024)} KB cap per file`; continue; }
    if (total + size > RUN_CAP) { row.status = 'refused'; row.why = `over the ${RUN_CAP / 1024 / 1024} MB cap per run`; continue; }
    if (!apply) { row.status = 'adoptable'; continue; }
    const unit = target === GOAL_DIR ? null : s.units.find((u) => u.id === target);
    try {
      const id = addEvidence(s, unit, { kind: kindOf(ext), file: path, label: `adopted: ${basename(path)}`, source: path }, runDir);
      const item = (unit ? unit.evidence : s.goalEvidence).find((e) => e.id === id);
      row.status = 'adopted'; row.evidence = item.file; total += size;
      have.push([item, unit]);
    } catch (e) { row.status = 'refused'; row.why = e.message.replace(/^--file /, ''); }
  }
  return rows;
}

// Stored files whose bytes are gone or changed, with the way to get them back:
// [{ file, unit, problem, source?, sourceExists }].
export function verifyStored(s, runDir) {
  const bad = [];
  for (const [e, u] of stored(s)) {
    const problem = damage(e, runDir);
    if (problem) bad.push({ file: e.file, unit: u?.id ?? null, problem, source: e.source ?? null, sourceExists: !!e.source && existsSync(e.source) });
  }
  return bad;
}

export const table = (rows) => rows.map((r) => `${r.status.padEnd(10)} ${r.unit.padEnd(12)} ${r.path}${r.why ? `  (${r.why})` : ''}${r.evidence ? `  → ${r.evidence}` : ''}`).join('\n');
