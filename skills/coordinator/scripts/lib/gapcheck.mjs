// `run.mjs gaps --check`: asks GitHub (through `gh`, the person's own login)
// about the refs open gaps are tracked by. The only network call the gaps
// view makes, and only when asked. It plans; the CLI writes each closure as a
// `gap close` decision note (by lead, `checked`). What it asks, per open gap
// (references/hud.md), and nothing else (a ref a note merely mentions, "see
// #1230", "compare with …/pull/1230", is never asked):
//   a stopped or unfinished unit's own linked PRs: one merged closes the gap,
//     "its PR merged; the critic's last gap was not re-checked", and the merge
//     is recorded as the unit's link
//   a gap tracked (unverified) in another repo's ref (lib/gaps.mjs: right after
//     a tracking verb): the ref exists closes it, "tracked in <ref>, which exists"
import { spawnSync } from 'node:child_process';
import { gaps } from './gaps.mjs';

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

const parse = (url) => { const m = ghUrl.exec(String(url ?? '')); return m && SAFE.test(m[1]) ? { repo: m[1], n: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/${m[3]}`, kind: m[2] === 'pull' ? 'pr' : 'issue' } : null; };
const key = (r) => `${r.repo}#${r.n}`;

// What to ask for each open gap. `runs`: the run states; `only`: one run id or null.
export function refsToCheck(runs, only = null) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const out = [];
  for (const g of gaps(runs)) {
    if (g.status !== 'open' || (only && g.run !== only)) continue;
    if (g.kind === 'stopped' || g.kind === 'unfinished') {
      const u = byId.get(g.run).units.find((x) => x.id === g.unit);
      const prs = (u?.links ?? []).map((l) => parse(l?.url)).filter((r) => r?.kind === 'pr');
      if (prs.length) out.push({ gap: g, how: 'own-pr', refs: dedupe(prs) });
    }
    if (g.unverified?.length) out.push({ gap: g, how: 'tracked', refs: dedupe(g.unverified.map(parse).filter(Boolean)) });
  }
  return out.filter((x) => x.refs.length);
}
const dedupe = (refs) => { const m = new Map(); for (const r of refs) if (!m.has(key(r))) m.set(key(r), r); return [...m.values()]; };

// The state of one reference: { state: 'merged' | 'closed' | 'closed-unmerged' | 'open' | 'missing', pr, url, merge? }.
export function lookUp(gh, ref) {
  const r = gh(['api', `repos/${ref.repo}/issues/${ref.n}`]);
  if (r.status !== 0) return { state: 'missing', pr: false, url: ref.url };
  let j; try { j = JSON.parse(r.stdout); } catch { return { state: 'missing', pr: false, url: ref.url }; }
  const pr = !!j.pull_request;
  const url = `https://github.com/${ref.repo}/${pr ? 'pull' : 'issues'}/${ref.n}`;
  if (pr && j.pull_request.merged_at) {
    const p = gh(['api', `repos/${ref.repo}/pulls/${ref.n}`]);
    let sha = null; try { sha = JSON.parse(p.stdout).merge_commit_sha ?? null; } catch { /* no sha: link the PR */ }
    return { state: 'merged', pr, url, merge: sha && /^[0-9a-f]{7,40}$/.test(sha) ? `https://github.com/${ref.repo}/commit/${sha}` : url };
  }
  return { state: j.state === 'closed' ? (pr ? 'closed-unmerged' : 'closed') : 'open', pr, url };
}

// The closures a check would make. Each GitHub reference is asked once.
export function planCheck(runs, { only = null, gh = realGh, today = new Date().toISOString().slice(0, 10) } = {}) {
  const why = ghReady(gh);
  if (why) return { ok: false, error: why, closes: [], asked: 0 };
  const cache = new Map();
  const ask = (r) => { if (!cache.has(key(r))) cache.set(key(r), lookUp(gh, r)); return cache.get(key(r)); };
  const closes = []; const done = new Set();
  for (const { gap, how, refs } of refsToCheck(runs, only)) {
    if (done.has(gap.id)) continue;
    if (how === 'own-pr') {
      const hit = refs.map((r) => ask(r)).find((s) => s.state === 'merged');
      if (!hit) continue;
      closes.push({ run: gap.run, gap: gap.id, unit: gap.unit, ref: hit.url, state: 'merged', merge: hit.merge, reason: `checked on ${today}: its PR ${hit.url} merged; the critic's last gap was not re-checked` });
    } else {
      const hit = refs.map((r) => ask(r)).find((s) => s.state !== 'missing');
      if (!hit) continue;
      closes.push({ run: gap.run, gap: gap.id, unit: gap.unit, ref: hit.url, state: 'exists', merge: null, reason: `checked on ${today}: tracked in ${hit.url}, which exists (${hit.state})` });
    }
    done.add(gap.id);
  }
  return { ok: true, closes, asked: cache.size };
}
