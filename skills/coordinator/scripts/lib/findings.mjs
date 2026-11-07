// Findings and fold-ins as the critic reports them (references/bar.md, Severity), and the
// guards on a fold-in: what a pass may carry, and what the fold-in check may let through.
import { execFileSync } from 'node:child_process';
import { pinned } from './models.mjs';
import { SEVERITIES } from './rules.mjs';

const LEAD = /^\s*\[?(high|medium|low|nit)\]?\s*[:\-–]?\s+/i;

// "medium: two labels unclear" (or "[medium] …") → { severity, text }; a line without one is refused.
export function parseFinding(raw) {
  const s = String(raw ?? '').trim();
  const m = LEAD.exec(s);
  if (!m || !s.slice(m[0].length).trim()) throw new Error(`--finding must start with its severity (${SEVERITIES.join(', ')}): "medium: two labels unclear", got: ${s.slice(0, 80)}`);
  return { severity: m[1].toLowerCase(), text: s.slice(m[0].length).trim() };
}

// Words that mark a fold as more than small. A fold carries its severity ("low: …", "nit: …";
// none means low), and one that reads high or medium, or touches a pinned class (money, auth,
// security, personal data…, the stems routing pins to the strong model), needs a round instead.
const SERIOUS = /\b(?:high|medium|critical|blocker|severe|major|data loss|vulnerab\w*|exploit\w*|leak\w*)\b/i;
export function checkFold(raw) {
  const s = String(raw ?? '').trim();
  const m = LEAD.exec(s);
  const severity = m ? m[1].toLowerCase() : 'low';
  const words = m ? s.slice(m[0].length).trim() : s;
  if (!words) throw new Error('--fold needs its text');
  if (!['low', 'nit'].includes(severity)) throw new Error(`fold refused: a ${severity} finding is not a fold-in; fail the round (--severity ${severity})`);
  const serious = SERIOUS.exec(words);
  if (serious) throw new Error(`fold refused: "${words.slice(0, 80)}" reads as more than small ("${serious[0]}"); fail the round, or reword it if it is a low`);
  if (pinned(words)) throw new Error(`fold refused: "${words.slice(0, 80)}" touches a pinned area (money, auth, security, personal data…; references/routing.md); that needs a round with its critic, not a fold-in`);
  return { severity, text: words };
}

// The fold-in caps: files and lines changed since the reviewed head. Small on purpose.
export const FOLD_DEFAULTS = { files: 10, lines: 200 };

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
function commit(ref, name, cwd) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{7,64}$/i.test(ref)) throw new Error(`${name} must be a commit id`);
  try { return git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd).trim(); } catch { throw new Error(`${name} ${ref} is not a commit in ${cwd}`); }
}

// What changed from the reviewed head to the fold head, from git in `cwd` (the critic's checkout):
// the full ids, whether the fold head descends from the reviewed one, and files and lines changed.
export function foldDiff(reviewed, head, cwd = process.cwd()) {
  const r = commit(reviewed, 'the reviewed head', cwd); const h = commit(head, '--head', cwd);
  let descends = true;
  try { git(['merge-base', '--is-ancestor', r, h], cwd); } catch { descends = false; }
  let files = 0; let lines = 0;
  if (descends) for (const row of git(['diff', '--numstat', '--no-renames', r, h], cwd).split('\n').filter(Boolean)) {
    const [a, d] = row.split('\t');
    files++; lines += (Number(a) || 0) + (Number(d) || 0); // a binary file counts as a file, no lines
  }
  return { reviewed: r, head: h, descends, files, lines };
}
