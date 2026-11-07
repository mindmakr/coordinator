// What run.mjs needs for the report and retro pages and the report and quality
// commands. Files kept in the run's folder, so a deleted worktree loses nothing:
//   report/draft.json, report/draft.md   the git-derived draft (run.mjs report --draft)
//   quality.json                          the last quality measurement (run.mjs quality <run>)
// The lead's notes themselves live in the run's state (event `report`), so push and pull carry them.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { readJson, writeAtomic, writeJson } from '../store.mjs';
import { maskLine } from '../quality/secretline.mjs';
import { maskSecrets } from '../secrets.mjs';
import { loadRuns, loadSelf } from '../selfdata.mjs';
import { quality, qualityText } from '../quality/index.mjs';
import { loadMap } from '../quality/redundancy.mjs';
import { retroModel, retroPage } from '../retro.mjs';
import { changedPaths, draft, draftMarkdown, gitRunner, unitDiffs } from './draft.mjs';
import { reportPage } from './page.mjs';

export const NOTES_MAX = 200 * 1024;
const files = (dir) => ({ draft: join(dir, 'report', 'draft.json'), draftMd: join(dir, 'report', 'draft.md'), quality: join(dir, 'quality.json') });
const tryJson = (f) => { try { return existsSync(f) ? readJson(f, null) : null; } catch { return null; } };

// The closed rule: release notes never carry credentials, tokens or one-time codes. After masking,
// a line where a credential word (any language) has a value nearby is refused until the lead checks
// it (--i-checked). Nearby: within the next six words on its line, or the first word of the next line
// when the word ends its line with ":". A value is a word with a letter and a digit or symbol, a run of
// four or more digits, or any non-plain word right after "<word>:" or "<word> is". Values are never echoed.
const CRED = /(?:\b(?:pass(?:word|wd|phrase|code)?|pwd|pw|token|secret|api[_ -]?key|private[_ -]?key|credentials?|login|otp|pin|passcode|verification|code)\b(?![.\/_-]\w)|كلمة (?:المرور|السر)|پاس ?ورڈ|\bpasswort\b|\bkennwort\b|\bmot de passe\b|\bcontraseña|\bsenha\b)/giu;
const AFTER_PASS = /^\s*(?:[:=]|is\b)\s*["'`]?([^\s"'`|,;]{6,})/i;
const plainWord = (v) => /^[a-z]+[.,;:!?)]*$/.test(v) || /^[A-Z][A-Z0-9_]*$/.test(v) || /^[A-Z][a-z]+[.,;:!?)]*$/.test(v);
// A file, a file:line, a URL, a PR or a value already masked is not a credential.
const pathLike = (v) => /[/\\]|\.[a-z]{1,5}(?::\d+)?[`).,;]*$|^https?:|^#\d+|\[redacted\]/i.test(v);
const valueLike = (v) => !pathLike(v) && ((v.length >= 8 && /[A-Za-z]/.test(v) && /[0-9!@#$%^&*+=?~]/.test(v)) || /^\d[\d -]{2,}\d$/.test(v));
export function credentialLines(text) {
  const out = []; const L = text.split('\n');
  L.forEach((l, i) => {
    for (const m of l.matchAll(CRED)) {
      let rest = l.slice(m.index + m[0].length, m.index + m[0].length + 80);
      if (/^(?:\s+to)?\s*:\s*$/i.test(rest) && L[i + 1] !== undefined) rest = `: ${L[i + 1].replace(/^\s*[-*>|]?\s*/, '')}`;
      const direct = AFTER_PASS.exec(rest)?.[1]?.replace(/[.,;:!?)]+$/, '');
      const near = rest.split(/[\s|`"'(),;]+/).map((v) => v.replace(/[.:!?]+$/, '')).filter(Boolean).slice(0, 6);
      if ((direct && !pathLike(direct) && !plainWord(direct)) || near.some(valueLike)) { out.push(i + 1); break; }
    }
  });
  return out;
}

// --file: the lead's release notes (Markdown or text), masked as a whole (values on the next line)
// and line by line, into the state. Refused while a line still looks like it holds a credential.
export function storeReport(s, file, { checked = false } = {}) {
  if (typeof file !== 'string' || !existsSync(file) || !statSync(file).isFile()) throw new Error(`--file: no file ${file}`);
  if (!['.md', '.markdown', '.txt'].includes(extname(file).toLowerCase())) throw new Error('--file must be a .md or .txt file');
  if (statSync(file).size > NOTES_MAX) throw new Error(`--file is larger than ${NOTES_MAX / 1024} KB`);
  const text = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('--file is empty');
  const masked = maskSecrets(text).split('\n').map((l) => maskLine(l)).join('\n');
  const left = checked ? [] : credentialLines(masked);
  if (left.length) throw new Error(`report refused: ${left.map((n) => `${basename(file)}:${n}`).join(', ')} still looks like a credential next to a password-like value. Remove it, or pass --i-checked once you have checked it is not one.`);
  s.report = { text: masked, source: basename(file), at: new Date().toISOString() };
}

// draft: read git and keep the draft; quality: measure (run may be null for --project); neither: what is stored.
export function reportFor(run, dir, { draft: wantDraft = false, quality: wantQuality = false, root = process.cwd() } = {}) {
  const git = gitRunner(root);
  if (wantDraft) {
    const d = draft(run, { git });
    const md = draftMarkdown(d, run);
    writeJson(files(dir).draft, d); writeAtomic(files(dir).draftMd, md);
    return { markdown: md };
  }
  if (wantQuality) {
    const changed = run ? changedPaths(unitDiffs(run, git)) : null;
    const q = quality({ root, changed: changed?.length ? changed : null, map: dir ? loadMap(dir) : null });
    if (dir) writeJson(files(dir).quality, q);
    return { quality: q, text: qualityText(q) };
  }
  const f = files(dir);
  return {
    run: run.id, notes: run.report ? { at: run.report.at, source: run.report.source ?? null, chars: run.report.text.length } : null,
    draft: existsSync(f.draftMd) ? f.draftMd : null, quality: existsSync(f.quality) ? f.quality : null, page: join(dir, 'report.html'),
    ...(run.report ? {} : { next: `run.mjs report ${run.id} --draft, write the notes (references/sub-skills/release-notes.md), then run.mjs report ${run.id} --file notes.md` }),
  };
}

function lessonsOf() {
  const { lessons } = loadSelf();
  return [...(lessons.global ?? []).map((l) => ({ ...l, scope: 'global' })), ...(lessons.project ?? []).map((l) => ({ ...l, scope: 'project' }))];
}

// [[file name, html]] for report.html and retro.html, or just the one named ('report' | 'retro').
export function reportPages(s, v, dir, ctx, only = null) {
  const out = [];
  if (only !== 'retro') out.push(['report.html', reportPage(v, Date.now(), ctx, { report: s.report ?? null, draft: tryJson(files(dir).draft), quality: tryJson(files(dir).quality) })]);
  if (only !== 'report') {
    // Other runs are read only once the retro matters (every unit decided, or closed): it keeps each change cheap.
    const closed = v.retroPending || s.closed || (s.notes ?? []).some((n) => n.kind === 'retro') ? loadRuns().filter((r) => r.closed) : [];
    out.push(['retro.html', retroPage(retroModel(s, { lessons: lessonsOf(), closed }), v, Date.now(), ctx, v.retroPending ?? false)]);
  }
  return out;
}

