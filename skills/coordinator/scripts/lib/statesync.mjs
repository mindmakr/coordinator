// Pit-stop copies of a run, so another machine can pick it up: the run's event
// log, its snapshot and a plain README, plus project lessons and one stats line
// per closed run, written to a `coordinator-state` branch (or a folder) only
// when the lead calls `push`. Everything written is masked first: secrets
// become [redacted], the project path becomes `.`, the home folder `~`.
// A public repo is refused unless a private companion repo is configured.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { EVENTS, STATE, parseLog, readRun, replay, snapshotText, updateRun } from './events.mjs';
import { maskSecrets } from './secrets.mjs';
import { safeId, withLock, writeAtomic } from './store.mjs';

export const BRANCH = 'coordinator-state';
const MARKER = '.coordinator-state';
const README = `# Coordinator state\n\nMachine state written by the coordinator skill at pit stops (a unit merged, a\ndecision recorded, a run closed). Do not edit by hand: \`run.mjs pull <run>\`\nrestores a run on another machine. Format: skills/coordinator/references/durability.md.\n`;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Masks secrets and local paths in every string of a value.
export function redactor(project) {
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  const pathRe = (p) => new RegExp(escape(resolve(p).replace(/[\\/]+$/, '')).replace(/\\\\|\//g, '[\\\\/]'), flags);
  const swaps = [[pathRe(project), '.'], [pathRe(homedir()), '~']];
  const str = (s) => swaps.reduce((t, [re, to]) => t.replace(re, to), maskSecrets(s));
  const deep = (v) => (typeof v === 'string' ? str(v) : Array.isArray(v) ? v.map(deep) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return deep;
}
const redactLog = (log, red) => Buffer.from(log.events.map((e) => `${JSON.stringify(red(e))}\n`).join(''));

// .coordinator/coordinator.json (optional): { visibility, remote, stateRepo, branch }.
function config(base) {
  const file = join(base, 'coordinator.json');
  if (!existsSync(file)) return {};
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObj(c)) throw new Error(`${file}: expected an object`);
  if (c.visibility !== undefined && !['private', 'internal', 'public'].includes(c.visibility)) throw new Error(`${file}: visibility must be private, internal or public`);
  for (const k of ['remote', 'stateRepo', 'branch']) if (c[k] !== undefined && (typeof c[k] !== 'string' || !c[k] || c[k].startsWith('-'))) throw new Error(`${file}: ${k} must be a non-empty string`);
  return c;
}

const run = (cwd, args, { input, env, buffer } = {}) => execFileSync('git', args, {
  cwd, input, env: { ...process.env, ...env }, encoding: buffer ? null : 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28,
});
const tryGit = (cwd, args, o) => { try { return run(cwd, args, o); } catch { return null; } };

// A folder is an absolute path or one starting with ./ ../ or ~; anything else names a branch.
function where(spec, cfg) {
  if (spec === undefined) return { branch: cfg.branch ?? BRANCH };
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('--to/--from needs a branch name or a folder');
  if (isAbsolute(spec) || /^(\.{1,2}|~)([\\/]|$)/.test(spec)) return { folder: resolve(spec.replace(/^~/, homedir())) };
  return { branch: spec };
}

// Where the state may go: the private primary repo's remote, the companion repo
// for a public one, or only the local branch when the repo has no remote.
function destination(project, cfg, t) {
  if (t.folder) {
    const rel = relative(project, t.folder);
    const inside = !rel.startsWith('..') && !isAbsolute(rel);
    if (inside) gate(project, cfg, `the folder ${t.folder} is inside the repo`);
    return { folder: t.folder };
  }
  const branch = t.branch;
  if (branch.startsWith('-') || tryGit(project, ['check-ref-format', '--branch', branch]) === null) throw new Error(`not a branch name: ${branch}`);
  if (['main', 'master', 'HEAD'].includes(branch)) throw new Error(`refused: state never goes to ${branch}; use ${BRANCH}`);
  if (cfg.stateRepo) return { branch, remote: cfg.stateRepo, companion: true };
  const remote = cfg.remote ?? 'origin';
  const remotes = (tryGit(project, ['remote']) ?? '').split(/\s+/).filter(Boolean);
  if (!remotes.includes(remote)) {
    if (cfg.remote) throw new Error(`no git remote named ${remote}`);
    return { branch, remote: null };
  }
  gate(project, cfg, `the repo's ${remote}`);
  const head = (tryGit(project, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]) ?? '').trim().replace(`${remote}/`, '');
  if (branch === head) throw new Error(`refused: state never goes to ${branch} (the default branch); use ${BRANCH}`);
  return { branch, remote };
}

// Design Q7: run state (questions, notes, evidence) never lands in a public repo.
function gate(project, cfg, what) {
  const vis = cfg.visibility ?? (() => { try { return execFileSync('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim().toLowerCase(); } catch { return ''; } })();
  if (vis === 'public') throw new Error(`refused: ${what} belongs to a public repo; set "stateRepo" in .coordinator/coordinator.json to a private companion repo, or push to a folder outside the repo`);
  if (!['private', 'internal'].includes(vis)) throw new Error(`refused: cannot tell whether the repo is public (${what}); set "visibility" in .coordinator/coordinator.json`);
}

function tip(project, d) {
  if (!d.remote) return (tryGit(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${d.branch}^{commit}`]) ?? '').trim() || null;
  if (!run(project, ['ls-remote', '--heads', d.remote, `refs/heads/${d.branch}`]).trim()) return null;
  run(project, ['fetch', '--quiet', '--no-tags', d.remote, `refs/heads/${d.branch}`]);
  return run(project, ['rev-parse', 'FETCH_HEAD']).trim();
}

function reader(project, d, at) {
  if (d.folder) return (p) => { const f = join(d.folder, p); return existsSync(f) ? readFileSync(f) : null; };
  return (p) => (at ? tryGit(project, ['cat-file', 'blob', `${at}:${p}`], { buffer: true }) : null);
}

const IDENT = { GIT_AUTHOR_NAME: 'coordinator', GIT_AUTHOR_EMAIL: 'coordinator@localhost', GIT_COMMITTER_NAME: 'coordinator', GIT_COMMITTER_EMAIL: 'coordinator@localhost' };
function commit(project, parent, files, message) {
  const env = { GIT_INDEX_FILE: join(tmpdir(), `coordinator-index-${process.pid}-${Date.now()}`) };
  try {
    run(project, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = run(project, ['hash-object', '-w', '--stdin'], { input: content }).trim();
      run(project, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    }
    const tree = run(project, ['write-tree'], { env }).trim();
    if (parent && run(project, ['rev-parse', `${parent}^{tree}`]).trim() === tree) return null;
    const named = (tryGit(project, ['config', 'user.email']) ?? '').trim();
    return run(project, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: named ? {} : IDENT }).trim();
  } finally { rmSync(env.GIT_INDEX_FILE, { force: true }); }
}

function statsLine(s) {
  const minutes = s.closed?.at && s.createdAt ? Math.round((Date.parse(s.closed.at) - Date.parse(s.createdAt)) / 60_000) : null;
  return { v: 1, run: s.id, tag: s.tag ?? null, outcome: s.closed.outcome, decision: s.closed.decision ?? null, createdAt: s.createdAt ?? null, closedAt: s.closed.at ?? null, minutes, units: s.units.length, passed: s.units.filter((u) => u.status === 'pass').length, rounds: s.units.reduce((n, u) => n + (u.rounds?.length ?? 0), 0) };
}

// The files one push writes, from the run's log (masked) and what the target already holds.
function files(o, red, read) {
  const runId = safeId(o.run, 'run');
  // Persist any pending import or rebuild first, so the pushed log is the run's whole history.
  updateRun(o.dir, { kind: 'state.edited' }, () => {});
  const log = withLock(join(o.dir, STATE), () => readRun(o.dir)).log;
  const buf = redactLog(log, red);
  const state = replay(parseLog(buf, `masked ${EVENTS}`).events);
  // Only ever extend the copy: a push never drops events another machine pushed.
  const theirs = read(`runs/${runId}/${EVENTS}`);
  if (theirs && !buf.subarray(0, theirs.length).equals(theirs)) {
    if (theirs.subarray(0, buf.length).equals(buf)) throw new Error(`refused: the copy of ${runId} has events this machine lacks; run.mjs pull ${runId} first; nothing pushed`);
    throw new Error(`refused: the local ${runId} and the copy have different histories after event ${firstDiff(buf, theirs)}; nothing pushed`);
  }
  const out = {
    [MARKER]: 'v1\n', 'README.md': README,
    [`runs/${runId}/${EVENTS}`]: buf,
    [`runs/${runId}/${STATE}`]: snapshotText(state, log.events.length, buf),
    [`runs/${runId}/README.md`]: red(o.render(state)),
  };
  const lessons = join(o.base, 'lessons.json');
  if (existsSync(lessons)) out['lessons/lessons.json'] = `${JSON.stringify(red(JSON.parse(readFileSync(lessons, 'utf8'))), null, 2)}\n`;
  if (state.closed) {
    const lines = String(read('stats/runs.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.run !== state.id);
    lines.push(statsLine(state));
    out['stats/runs.jsonl'] = lines.sort((a, b) => a.run.localeCompare(b.run)).map((l) => `${JSON.stringify(l)}\n`).join('');
  }
  return { out, seq: log.events.length };
}

// push({ run, dir, base, project, to, message, render }) → what was written where.
export function push(o) {
  const cfg = config(o.base);
  const d = destination(o.project, cfg, where(o.to, cfg));
  const red = redactor(o.project);
  if (d.folder) {
    if (existsSync(d.folder) && readdirSync(d.folder).length && !existsSync(join(d.folder, MARKER))) throw new Error(`refused: ${d.folder} is not empty and holds no coordinator state`);
    const { out, seq } = files(o, red, reader(o.project, d));
    for (const [p, c] of Object.entries(out)) writeAtomic(join(d.folder, p), c);
    return { pushed: true, to: d.folder, seq, files: Object.keys(out).sort() };
  }
  for (let attempt = 1; ; attempt++) {
    const parent = tip(o.project, d);
    if (parent && tryGit(o.project, ['cat-file', '-e', `${parent}:${MARKER}`]) === null) throw new Error(`refused: ${d.branch} exists and is not a coordinator state branch`);
    const { out, seq } = files(o, red, reader(o.project, d, parent));
    const c = commit(o.project, parent, out, o.message ?? `coordinator: ${o.run} at event ${seq}`);
    const report = { to: d.branch, remote: d.remote, seq, files: Object.keys(out).sort() };
    if (!c) return { pushed: false, unchanged: true, ...report };
    if (!d.remote) { run(o.project, ['update-ref', `refs/heads/${d.branch}`, c, parent ?? '0'.repeat(40)]); return { pushed: true, commit: c, ...report }; }
    try { run(o.project, ['push', '--quiet', d.remote, `${c}:refs/heads/${d.branch}`]); } catch (e) {
      if (attempt < 4 && /rejected|fetch first|non-fast-forward|stale info/i.test(String(e.stderr))) continue;
      throw new Error(`git push failed: ${String(e.stderr ?? e.message).trim()}`);
    }
    if (!d.companion) run(o.project, ['update-ref', `refs/heads/${d.branch}`, c]);
    return { pushed: true, commit: c, ...report };
  }
}

// pull({ run, dir, base, project, from, after }) → restored, fast-forwarded, or already up to date.
// A local log that has events the copy lacks is never overwritten.
export function pull(o) {
  const runId = safeId(o.run, 'run');
  const cfg = config(o.base);
  const t = where(o.from, cfg);
  const d = t.folder ? t : { branch: t.branch, remote: cfg.stateRepo ?? ((tryGit(o.project, ['remote']) ?? '').split(/\s+/).includes(cfg.remote ?? 'origin') ? (cfg.remote ?? 'origin') : null) };
  const read = reader(o.project, d, d.folder ? null : tip(o.project, d));
  const theirs = read(`runs/${runId}/${EVENTS}`);
  if (!theirs) throw new Error(`no run ${runId} in ${d.folder ?? d.branch}`);
  const remote = parseLog(theirs, `${d.folder ?? d.branch}:runs/${runId}/${EVENTS}`);
  const red = redactor(o.project);
  const result = withLock(join(o.dir, STATE), () => {
    const cur = readRun(o.dir);
    if (cur?.legacy || cur?.edited) throw new Error(`refused: the local ${runId} has changes outside its event log; run any run.mjs step on it first, or move it aside`);
    let buf; let status;
    if (!cur) { buf = remote.buf; status = 'restored'; }
    else {
      const mine = redactLog(cur.log, red);
      if (mine.subarray(0, remote.buf.length).equals(remote.buf)) return { status: mine.length === remote.buf.length ? 'up-to-date' : 'local-ahead', seq: cur.seq, state: null };
      if (!remote.buf.subarray(0, mine.length).equals(mine)) throw new Error(`refused: the local ${runId} and the copy have different histories after event ${firstDiff(mine, remote.buf)}; nothing changed`);
      buf = Buffer.concat([cur.log.buf, remote.buf.subarray(mine.length)]); status = 'fast-forward';
    }
    const log = parseLog(buf, EVENTS);
    const state = replay(log.events);
    writeAtomic(join(o.dir, EVENTS), buf);
    writeAtomic(join(o.dir, STATE), snapshotText(state, log.events.length, buf));
    o.after?.(state);
    return { status, seq: log.events.length, added: log.events.length - (cur?.seq ?? 0), state };
  });
  const lessons = join(o.base, 'lessons.json'); const got = read('lessons/lessons.json');
  const restored = got && !existsSync(lessons);
  if (restored) writeAtomic(lessons, got);
  const { state, ...rest } = result;
  return { run: runId, from: d.folder ?? d.branch, ...rest, lessons: restored ? 'restored' : 'kept' };
}

const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.subarray(0, i).toString('utf8').split('\n').length - 1; };
