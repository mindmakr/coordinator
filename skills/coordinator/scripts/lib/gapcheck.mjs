// `run.mjs gaps --check`: asks GitHub (through `gh`, the person's own login)
// whether the issues and PRs that open gaps name are closed or merged. The
// only network call the gaps view makes, and only when asked. It plans; the
// CLI writes each closure as a `gap close` decision note (by lead, `checked`).
// Which references count, per gap (references/hud.md):
//   stopped, unfinished  the unit's own issue and PR links, and refs in its last gap
//   a note's gap         refs in its text, minus the work's own links (the run's unit
//                        issues and PRs) and refs right after a wait (after, until,
//                        once, when, waits on, waiting for)
//   run                  refs in its closing reason, minus the work's own links
// A unit gap closes when its own PR merged (the merge is recorded as a link too),
// else when every own issue is closed; any other gap when every ref it names is
// a merged PR or a closed issue.
import { spawnSync } from 'node:child_process';
import { allRefs, gaps, runRepo } from './gaps.mjs';

const WAITED = /\b(?:after|until|once|when|waits?\s+(?:on|for)|waiting\s+(?:on|for))\s+(?:pr\s+|pull\s+request\s+|issue\s+)?$/i;
// A bare #n is the run's repo only after one of these words (or none): "mobile #237" names another repo's number.
const BARE_OK = /(?:^|[^\w\s]\s*|\b(?:pr|pull|request|issue|issues|in|to|at|see|by|and|or|as|via|under|fixed|closes|fixes)\s+)$/i;
const plain = (r) => !r.bare || BARE_OK.test(r.before);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const ghUrl = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/;

// gh, found on PATH (on Windows through the shell, so gh.exe and a gh.cmd both run). Every argument is checked first.
export function realGh(args) {
  if (!args.every((a) => /^[A-Za-z0-9._/:=-]+$/.test(a))) throw new Error('unsafe gh argument');
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const missing = r.error?.code === 'ENOENT' || (process.platform === 'win32' && r.status !== 0 && /not recognized|cannot find/i.test(r.stderr ?? ''));
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', missing };
}

// null when gh can be used; else why not.
export function ghReady(gh) {
  const v = gh(['--version']);
  if (v.missing || v.status !== 0) return 'gh (the GitHub CLI) is not installed or not on PATH: nothing checked, nothing changed';
  const a = gh(['auth', 'status', '--hostname', 'github.com']);
  if (a.status !== 0) return 'gh is not signed in to github.com (gh auth login): nothing checked, nothing changed';
  return null;
}

const linkRefs = (u) => (u?.links ?? []).map((l) => ghUrl.exec(String(l?.url ?? ''))).filter(Boolean).map((m) => ({ repo: m[1], n: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/${m[3]}`, kind: m[2] === 'pull' ? 'pr' : 'issue' }));
const key = (r) => `${r.repo}#${r.n}`;

// What to ask for each open gap. `runs`: the run states; `only`: one run id or null.
export function refsToCheck(runs, only = null) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const out = [];
  for (const g of gaps(runs)) {
    if (g.status !== 'open' || (only && g.run !== only)) continue;
    const run = byId.get(g.run); const repo = runRepo(run);
    const own = new Set(run.units.flatMap((u) => linkRefs(u).map(key)));
    if (g.kind === 'stopped' || g.kind === 'unfinished') {
      const u = run.units.find((x) => x.id === g.unit);
      const refs = [...linkRefs(u), ...allRefs(g.text, repo).filter((r) => plain(r) && !WAITED.test(r.before))];
      if (refs.length) out.push({ gap: g, unit: true, refs: dedupe(refs) });
    } else if (g.kind !== 'question') {
      const refs = allRefs(g.text, repo).filter((r) => plain(r) && !WAITED.test(r.before) && !own.has(key(r)));
      if (refs.length) out.push({ gap: g, unit: false, refs: dedupe(refs) });
    }
  }
  return out;
}
// The first mention wins, so a unit's own link keeps its kind (issue or PR).
const dedupe = (refs) => { const m = new Map(); for (const r of refs) if (SAFE.test(r.repo) && !m.has(key(r))) m.set(key(r), r); return [...m.values()]; };

// The state of one reference: { state: 'merged' | 'closed' | 'open' | 'unknown', pr, url, merge? }.
export function lookUp(gh, ref) {
  const r = gh(['api', `repos/${ref.repo}/issues/${ref.n}`]);
  if (r.status !== 0) return { state: 'unknown', pr: false, url: ref.url };
  let j; try { j = JSON.parse(r.stdout); } catch { return { state: 'unknown', pr: false, url: ref.url }; }
  const pr = !!j.pull_request;
  const url = `https://github.com/${ref.repo}/${pr ? 'pull' : 'issues'}/${ref.n}`;
  if (pr) {
    if (!j.pull_request.merged_at) return { state: j.state === 'closed' ? 'closed-unmerged' : 'open', pr, url };
    const p = gh(['api', `repos/${ref.repo}/pulls/${ref.n}`]);
    let sha = null; try { sha = JSON.parse(p.stdout).merge_commit_sha ?? null; } catch { /* no sha: link the PR */ }
    return { state: 'merged', pr, url, at: j.pull_request.merged_at, merge: sha && /^[0-9a-f]{7,40}$/.test(sha) ? `https://github.com/${ref.repo}/commit/${sha}` : url };
  }
  return { state: j.state === 'closed' ? 'closed' : 'open', pr, url, reason: j.state_reason ?? null };
}

const done = (s) => s.state === 'merged' || (s.state === 'closed' && !s.pr);
const word = (s) => (s.state === 'merged' ? 'merged' : `closed${s.reason === 'not_planned' ? ' (not planned)' : ''}`);

// The closures a check would make. Each GitHub reference is asked once.
export function planCheck(runs, { only = null, gh = realGh, today = new Date().toISOString().slice(0, 10) } = {}) {
  const why = ghReady(gh);
  if (why) return { ok: false, error: why, closes: [], asked: 0 };
  const cache = new Map();
  const ask = (r) => { if (!cache.has(key(r))) cache.set(key(r), lookUp(gh, r)); return cache.get(key(r)); };
  const closes = [];
  for (const { gap, unit, refs } of refsToCheck(runs, only)) {
    const seen = refs.map((r) => ({ r, s: ask(r) }));
    let hit = null;
    if (unit) {
      const pr = seen.find((x) => x.r.kind === 'pr' && x.s.state === 'merged');
      const issues = seen.filter((x) => x.r.kind === 'issue');
      if (pr) hit = { ...pr, merge: pr.s.merge };
      else if (issues.length && issues.every((x) => x.s.state === 'closed' && !x.s.pr)) hit = issues[0];
      else if (!seen.some((x) => x.r.kind) && seen.length && seen.every((x) => done(x.s))) hit = seen[0];
    } else if (seen.every((x) => done(x.s))) hit = seen[0];
    if (!hit) continue;
    closes.push({
      run: gap.run, gap: gap.id, unit: gap.unit, ref: hit.s.url, state: hit.s.state,
      reason: `checked on ${today}: ${hit.s.url} ${word(hit.s)}`, merge: unit && hit.merge ? hit.merge : null,
    });
  }
  return { ok: true, closes, asked: cache.size };
}
