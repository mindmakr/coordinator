// Text to safe HTML with clickable links. Only http(s) URLs and GitHub
// references become anchors: `owner/repo#123`, and with the run's repo known,
// `#123`, commit shas and branch names (feat/…, fix/…). Everything else is
// escaped. Anchors open in a new tab and send no referrer, so the answer
// page's token never leaves it.
import { execFileSync } from 'node:child_process';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

export const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PREFIX = 'feat|feature|fix|bugfix|hotfix|chore|docs|refactor|test|release|ci|perf|build';
// URL | owner/repo#n | #n | commit sha | branch name: one pass, the first match wins.
const TOKEN = new RegExp([
  /(https?:\/\/[^\s<>"'`]+)/.source,
  /(?<![\w/.-])([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})#(\d{1,7})\b/.source,
  /(?<![\w&/#])#(\d{1,7})\b/.source,
  /(?<![\w/#.-])([0-9a-f]{7,40})(?![\w-])/.source,
  `(?<![\\w/.-])((?:${BRANCH_PREFIX})\\/[A-Za-z0-9._/-]*[A-Za-z0-9_-])(?![\\w/])`,
].join('|'), 'g');
const isSha = (s) => /\d/.test(s) && /[a-f]/.test(s);
const isFile = (s) => /\.[a-z]{1,5}$/i.test(s);

// Only plain web links are allowed through; the rest are not links.
export function webUrl(raw) {
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}

export const anchor = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const gh = (repo, ...rest) => `https://github.com/${repo}/${rest.join('/')}`;
export const issueUrl = (repo, n) => gh(repo, 'issues', n); // GitHub redirects a PR number to its pull page

// A unit's --issue/--pr/--merge value as a URL: a web URL, owner/repo#n, or #n against the run's repo.
export function githubRef(raw, repo, kind = 'issue') {
  const v = String(raw ?? '').trim();
  if (/^https?:/i.test(v)) return webUrl(v);
  const m = /^(?:([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}))?#(\d{1,7})$/.exec(v);
  const r = m && (m[1] ?? repo);
  if (!r || !REPO.test(r)) return null;
  return kind === 'issue' ? issueUrl(r, m[2]) : gh(r, 'pull', m[2]);
}

// A short label for a GitHub issue or pull URL: #12 in the run's repo, owner/repo#12 elsewhere.
export function shortRef(url, repo) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)\/?$/.exec(url ?? '');
  if (!m) return url;
  return m[1] === repo ? `#${m[2]}` : `${m[1]}#${m[2]}`;
}

function target([, url, ownerRepo, num, bare, sha, branch], repo) {
  if (url) return webUrl(url);
  if (ownerRepo) return REPO.test(ownerRepo) ? issueUrl(ownerRepo, num) : null;
  if (!repo) return null;
  if (bare) return issueUrl(repo, bare);
  if (sha) return isSha(sha) ? gh(repo, 'commit', sha) : null;
  return isFile(branch) ? null : gh(repo, 'tree', branch.split('/').map(encodeURIComponent).join('/'));
}

export function linkify(text, repo = null) {
  const s = String(text ?? '');
  let out = ''; let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    let whole = m[0]; let tail = '';
    if (m[1]) { const t = /[).,;:!?\]]+$/.exec(whole); if (t) { tail = t[0]; whole = whole.slice(0, -tail.length); m[1] = whole; } }
    const url = target(m, repo);
    out += esc(s.slice(last, m.index)) + (url ? anchor(url, whole) : esc(whole)) + esc(tail);
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// owner/repo from a GitHub remote URL (https or ssh). Other hosts: null.
export function repoFromRemote(url) {
  const m = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m && REPO.test(m[1]) ? m[1] : null;
}

// The repo most GitHub issue and PR links in a text point at (an old run's state), or null.
export function repoFromText(text) {
  const counts = new Map();
  for (const m of String(text ?? '').matchAll(/https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/(?:issues|pull)\/\d+/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && REPO.test(best[0]) ? best[0] : null;
}

// Reads the project's own git config (no network). Cached per folder.
const cache = new Map();
export function inferRepo(cwd) {
  if (!cache.has(cwd)) {
    let repo = null;
    try { repo = repoFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* not a repo */ }
    cache.set(cwd, repo);
  }
  return cache.get(cwd);
}
