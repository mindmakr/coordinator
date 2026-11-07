// Files a run mentions by path (in reports, verdicts, notes, evidence text)
// often live in a worktree or a scratch folder that is deleted after the run.
// `adopt` copies each one that still exists into the run folder through the
// same checked code as `evidence --file`, as evidence of the unit that names it
// (run-level mentions go to the goal's evidence). The text stays as written;
// the stored copy is what the HUD shows. Adopting twice changes nothing.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { DOC, GOAL_DIR, IMAGE, LIMITS, TEXT, addEvidence, sha256 } from './evidence.mjs';

export const RUN_CAP = 50 * 1024 * 1024; // all adopted files of one run together
const EXT = [...Object.keys(IMAGE), ...Object.keys(TEXT), ...Object.keys(DOC)].map((e) => e.slice(1)).join('|');
const END = `\\.(?:${EXT})(?![A-Za-z0-9])`;
const CHARS = String.raw`[^\s"'\`<>|*?()\[\]{},;]`;
const PATH = new RegExp(String.raw`(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])?(?:${CHARS}+[\\/])+${CHARS}*?${END}`, 'gi');
// Never copied: secrets and key material, whatever their extension says.
const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*credentials.*|.*secret.*|\.npmrc|\.netrc)$/i;
// Fields that hold stored names, ids or links rather than prose.
const SKIP = new Set(['file', 'sha256', 'source', 'url', 'id', 'at', 'type', 'kind', 'bytes', 'label', 'behaviour']);

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (dir, p) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

// Paths in a piece of text; URLs are dropped first so their paths do not count.
export function pathsIn(text) {
  return [...String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').matchAll(PATH)].map((m) => m[0].replace(/[.:]+$/, ''));
}

// Resolves a mention; Git Bash's /c/Users/... becomes C:/Users/... on Windows.
export function resolveMention(p, project, home) {
  if (p.startsWith('~')) return resolve(home, p.slice(2));
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(p)) return resolve(`${p[1].toUpperCase()}:${p.slice(2)}`);
  return isAbsolute(p) ? resolve(p) : resolve(project, p);
}

// Every mention in the state: [{ path (resolved), target (unit id or GOAL_DIR) }], first mention wins.
export function mentions(s, { project, home }) {
  const found = new Map();
  const visit = (v, target) => {
    if (typeof v === 'string') { for (const p of pathsIn(v)) { const r = resolveMention(p, project, home); const k = process.platform === 'win32' ? r.toLowerCase() : r; if (!found.has(k)) found.set(k, { path: r, target }); } return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, target); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP.has(k)) visit(x, k === 'units' ? null : target);
  };
  for (const u of s.units ?? []) visit(u, u.id);
  for (const n of s.notes ?? []) visit(n, n.unit && (s.units ?? []).some((u) => u.id === n.unit) ? n.unit : GOAL_DIR);
  const { units, notes, ...rest } = s;
  visit(rest, GOAL_DIR);
  return [...found.values()];
}

const stored = (s) => [...(s.goalEvidence ?? []), ...(s.units ?? []).flatMap((u) => u.evidence ?? [])].filter((e) => e.file);

// Why a path may not be copied, or null.
export function refusal(p) {
  const parts = p.split(/[\\/]+/);
  if (parts.some((x) => x === 'node_modules' || x === '.git')) return 'inside node_modules or .git';
  if (SECRET.test(basename(p))) return 'looks like a secret or key file';
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return 'a symbolic link';
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
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// Classifies every mention, and with apply=true copies the adoptable ones into
// the state. Rows: { path, unit, status, why?, evidence? }; status is adopted
// (adoptable on a dry run), already, inside (the run folder), tracked (in git), missing or refused.
export function adopt(s, runDir, { project, home, apply = false, tracked = trackedFiles(project) }) {
  const rows = [];
  const have = stored(s);
  let total = have.reduce((n, e) => n + (e.source ? (e.bytes ?? 0) : 0), 0);
  for (const { path, target } of mentions(s, { project, home })) {
    const row = { path, unit: target };
    rows.push(row);
    if (inside(runDir, path)) { row.status = 'inside'; continue; }
    if (tracked.has(key(path))) { row.status = 'tracked'; continue; }
    const prior = have.find((e) => e.source && same(e.source, path));
    if (prior) { row.status = 'already'; row.evidence = prior.file; continue; }
    const why = refusal(path);
    if (why) { row.status = 'refused'; row.why = why; continue; }
    if (!existsSync(path)) { row.status = 'missing'; continue; }
    const size = statSync(path).size;
    const ext = extname(path).toLowerCase();
    if (size > (TEXT[ext] ? LIMITS.textFile : LIMITS.image)) { row.status = 'refused'; row.why = `over the ${Math.round((TEXT[ext] ? LIMITS.textFile : LIMITS.image) / 1024)} KB cap per file`; continue; }
    if (total + size > RUN_CAP) { row.status = 'refused'; row.why = `over the ${RUN_CAP / 1024 / 1024} MB cap per run`; continue; }
    if (!apply) { row.status = 'adoptable'; continue; }
    const unit = target === GOAL_DIR ? null : s.units.find((u) => u.id === target);
    try {
      const id = addEvidence(s, unit, { kind: IMAGE[ext] ? 'screenshot' : 'log', file: path, label: `adopted: ${basename(path)}`, source: path }, runDir);
      const item = (unit ? unit.evidence : s.goalEvidence).find((e) => e.id === id);
      row.status = 'adopted'; row.evidence = item.file; total += size;
      have.push(item);
    } catch (e) { row.status = 'refused'; row.why = e.message.replace(/^--file /, ''); }
  }
  return rows;
}

// Stored files whose bytes are gone or changed: [{ file, problem }].
export function verifyStored(s, runDir) {
  const bad = [];
  for (const e of stored(s)) {
    const f = join(runDir, 'artifacts', ...e.file.split('/'));
    let buf;
    try { buf = readFileSync(f); } catch { bad.push({ file: e.file, problem: 'missing' }); continue; }
    if (e.sha256 && sha256(buf) !== e.sha256) bad.push({ file: e.file, problem: 'changed (sha256 mismatch)' });
  }
  return bad;
}

export const table = (rows) => rows.map((r) => `${r.status.padEnd(9)} ${r.unit.padEnd(12)} ${r.path}${r.why ? `  (${r.why})` : ''}${r.evidence ? `  → ${r.evidence}` : ''}`).join('\n');
