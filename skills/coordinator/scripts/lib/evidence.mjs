// Evidence per unit (or for the goal): test output and logs inline, screenshots
// and small text files copied into the run folder, links as links. Text is
// masked for secrets and capped; a file must be a real image or a small text
// file; nothing outside the run's artifacts folder is ever served.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { STORED_FILE } from './eventschema.mjs';
import { oneOf, optText, text } from './args.mjs';
import { maskSecrets } from './secrets.mjs';
import { parseReinsReport } from './reinsreport.mjs';
import { webUrl } from './links.mjs';
import { writeAtomic } from './store.mjs';

// reins: the Markdown a reins session report or compare is saved as; its findings are read into the item (lib/reinsreport.mjs).
export const KINDS = ['test', 'screenshot', 'pdf', 'log', 'link', 'reins'];
// perRound: pieces per unit (or the goal) in one round, so a long unit never runs out (#66); a piece records the
// round it came in (pieces from before, with none, count toward no round). total: what an id (E1-E999) can number.
export const LIMITS = { text: 20_000, image: 5 * 1024 * 1024, textFile: 512 * 1024, perRound: 60, total: 999 };
export const GOAL_DIR = '_goal'; // cannot clash with a unit id, which starts with a letter or digit
export const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const TEXT = { '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8' };
// Other documents: copied byte for byte, checked by their magic bytes, served as a download.
export const DOC = { '.pdf': 'application/pdf' };
export const FILE_NAME = /^E\d{1,3}-[a-z0-9][a-z0-9._-]{0,80}$/;

const MAGIC = {
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.gif': (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
};
MAGIC['.jpeg'] = MAGIC['.jpg'];
MAGIC['.pdf'] = (b) => b.subarray(0, 5).toString('latin1') === '%PDF-';
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const listOf = (s, unit) => (unit ? (unit.evidence ??= []) : (s.goalEvidence ??= []));
const now = () => new Date().toISOString();

// The stored name: the evidence id plus a cleaned base name; no folders, no dots run.
function storedName(eid, src) {
  const ext = extname(src).toLowerCase();
  const stem = basename(src, extname(src)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  return `${eid}-${stem}${ext}`;
}

// Checks and copies a file into <runDir>/artifacts/<target>/; returns the stored
// relative path and the stored bytes' sha256, which `doctor` verifies later.
export function copyIn(src, runDir, target, eid) {
  const ext = extname(src).toLowerCase();
  if (!IMAGE[ext] && !TEXT[ext] && !DOC[ext]) throw new Error(`--file must be ${[...Object.keys(IMAGE), ...Object.keys(DOC), ...Object.keys(TEXT)].join(' ')}, got: ${ext || 'no extension'}`);
  let st;
  try { st = lstatSync(src); } catch { throw new Error(`no file: ${src}`); }
  if (!st.isFile()) throw new Error(`--file must be a regular file, not a link or folder: ${src}`);
  const cap = TEXT[ext] ? LIMITS.textFile : LIMITS.image;
  if (st.size > cap) throw new Error(`--file is ${Math.ceil(st.size / 1024)} KB; the cap is ${cap / 1024} KB`);
  const name = storedName(eid, src);
  const dir = join(runDir, 'artifacts', target);
  mkdirSync(dir, { recursive: true });
  const raw = readFileSync(src);
  let stored;
  if (!TEXT[ext]) {
    if (!MAGIC[ext](raw)) throw new Error(`--file does not look like a ${ext.slice(1)} file`);
    stored = raw;
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, stored); renameSync(tmp, join(dir, name));
  } else {
    if (raw.includes(0)) throw new Error('--file looks binary; text and log files only');
    stored = Buffer.from(maskSecrets(raw.toString('utf8')));
    writeAtomic(join(dir, name), stored);
  }
  return { file: `${target}/${name}`, type: IMAGE[ext] ? 'image' : DOC[ext] ? 'doc' : 'text', bytes: st.size, sha256: sha256(stored) };
}

// o: { kind, text?, file?, url?, label?, behaviour?, source? }. Returns the evidence id.
// source: the original path a file was adopted from (`run.mjs adopt`), so adopting twice is a no-op.
export function addEvidence(s, unit, o, runDir) {
  const kind = oneOf(o.kind, KINDS, '--kind');
  const given = ['text', 'file', 'url'].filter((k) => typeof o[k] === 'string');
  if (given.length !== 1) throw new Error('give exactly one of --text, --file or --url');
  let reins = null;
  if (kind === 'reins') {
    if (typeof o.file !== 'string' || extname(o.file).toLowerCase() !== '.md') throw new Error('--kind reins takes --file <the .md that reins_report or "reins report --compare" saved>');
    let md;
    try { if (lstatSync(o.file).size > LIMITS.textFile) throw new Error('big'); md = readFileSync(o.file, 'utf8'); } catch (e) { throw new Error(e.message === 'big' ? `--file is over the cap of ${LIMITS.textFile / 1024} KB` : `no file: ${o.file}`); }
    reins = parseReinsReport(maskSecrets(md));
    if (!reins) throw new Error('--kind reins: the file is not a reins session report or compare (its first heading is "# reins session: …" or "# reins compare: …"); attach other files with --kind log');
  }
  const list = listOf(s, unit);
  // The round this piece belongs to: the unit's try under way (or next), or the goal's integration round.
  const round = (unit ? unit.rounds?.length ?? 0 : s.integration?.rounds?.length ?? 0) + 1;
  if (list.length >= LIMITS.total) throw new Error(`${LIMITS.total} pieces of evidence at most for ${unit ? unit.id : 'the goal'}`);
  if (list.filter((e) => e.round === round).length >= LIMITS.perRound) throw new Error(`${LIMITS.perRound} pieces of evidence at most in one round (round ${round} of ${unit ? unit.id : 'the goal'})`);
  const behaviours = unit ? (unit.behaviours ?? []) : (s.goalBehaviours ?? []);
  const behaviour = o.behaviour === undefined ? null : String(o.behaviour).toUpperCase();
  if (behaviour && !behaviours.some((b) => b.id === behaviour)) throw new Error(`no behaviour ${o.behaviour}`);
  const eid = `E${list.length + 1}`;
  const item = { id: eid, kind, label: optText(o.label, 120), behaviour, round, at: now() };
  if (o.text !== undefined) {
    const t = text(o.text, 'text', LIMITS.text + 1);
    item.text = t.length > LIMITS.text ? `${t.slice(0, LIMITS.text)}\n… (cut at ${LIMITS.text} characters)` : t;
  } else if (o.url !== undefined) {
    const url = webUrl(o.url);
    if (!url || url.length > 500) throw new Error('--url must be an http(s) URL');
    item.url = maskSecrets(url);
  } else {
    Object.assign(item, copyIn(o.file, runDir, unit ? unit.id : GOAL_DIR, eid));
    if (typeof o.source === 'string') item.source = o.source;
    if (reins) item.reins = reins;
  }
  list.push(item);
  return eid;
}

// The stored copy of `file` (<target>/<name>) on disk, or null. Every read under artifacts/ goes
// through here: the name must be one `evidence` writes, nothing on the way may be a link, and the
// real path must sit directly in artifacts/<target>/, and the file may have no other name (a
// hard link to a file elsewhere counts as outside). Reads go through readStored/openStored.
export function storedPath(runDir, file) { return checked(runDir, file)?.p ?? null; }
function checked(runDir, file) {
  if (!runDir || typeof file !== 'string' || !STORED_FILE.test(file) || file.includes('..')) return null;
  const [target, name] = file.split('/');
  const root = join(runDir, 'artifacts'); const dir = join(root, target); const p = join(dir, name);
  try {
    if (lstatSync(root).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) return null;
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return null;
    if (dirname(realpathSync(p)) !== realpathSync(dir) || dirname(realpathSync(dir)) !== realpathSync(root)) return null;
    return { p, st };
  } catch { return null; }
}

// The stored copy opened once, read-only and (where the platform has it) not through a link; the
// open handle is checked again (a regular file, one name, the very file checked above), so nothing
// can swap it between the check and the read. Returns the fd, or null; the caller closes it.
export function openStored(runDir, file) {
  const c = checked(runDir, file); if (!c) return null;
  let fd;
  try {
    fd = openSync(c.p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (st.isFile() && st.nlink === 1 && st.ino === c.st.ino && st.dev === c.st.dev) return fd;
  } catch { /* gone, or refused */ }
  if (fd !== undefined) closeSync(fd);
  return null;
}
// The stored copy's bytes (or text with `enc`), read from that one handle; null when refused or gone.
export function readStored(runDir, file, enc) {
  const fd = openStored(runDir, file); if (fd === null) return null;
  try { return readFileSync(fd, enc); } catch { return null; } finally { closeSync(fd); }
}

// The served artifact for a request path's two parts, only when the state names it.
export function artifact(s, target, name) {
  if (!FILE_NAME.test(name ?? '') || name.includes('..')) return null;
  const list = target === GOAL_DIR ? (s.goalEvidence ?? []) : (s.units.find((u) => u.id === target)?.evidence ?? []);
  const item = list.find((e) => e.file === `${target}/${name}`);
  if (!item) return null;
  const ext = extname(name);
  return { rel: item.file, type: IMAGE[ext] ?? TEXT[ext] ?? DOC[ext] };
}
