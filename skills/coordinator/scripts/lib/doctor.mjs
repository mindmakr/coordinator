// `doctor`: is this machine and project set up for the coordinator? Each check
// returns { id, status: ok|warn|fail|skip, text, fix? }. Commands run through
// ctx.exec so tests can fake them; nothing printed carries a token: gh output
// is parsed, never echoed, URLs lose their credentials and every line is masked.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { adopt, trackedFiles, verifyStored } from './adopt.mjs';
import { STATE } from './events.mjs';
import { maskSecrets } from './secrets.mjs';
import { checkSettings, readSettings } from './settings.mjs';
import { themeFile } from './theme.mjs';

export const RELEASES = 'https://github.com/mindmakr/coordinator';
const LOCK_STALE_MS = 30_000;
const SKILLS = ['coordinator', 'investigate', 'plan', 'fix', 'review', 'verify', 'visual', 'translations', 'release-notes', 'board', 'doctor'];

export function realExec(cmd, args, { cwd, timeout = 20_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error?.code === 'ENOENT') return { missing: true, status: null, stdout: '', stderr: '' };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
}

// Drops user:password@ from URLs, then masks anything that looks like a secret.
export const clean = (s) => maskSecrets(String(s).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1'));
const out = (id, status, text, fix) => ({ id, status, text: clean(text), ...(fix ? { fix: clean(fix) } : {}) });
const semver = (s) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim()) ?? []).slice(1).map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
const rel = (from, p) => relative(from, p).replace(/\\/g, '/') || '.';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function nodeCheck(ctx) {
  const [major] = semver(ctx.node ?? process.versions.node);
  return major >= 18 ? out('node', 'ok', `Node ${ctx.node ?? process.versions.node}`)
    : out('node', 'fail', `Node ${ctx.node} is older than 18`, 'install Node 18 or newer (nodejs.org)');
}

export function versionCheck(ctx) {
  if (!ctx.online) return out('version', 'skip', `plugin ${ctx.version}; latest release not checked (offline)`, 'run doctor without --offline to compare');
  const r = ctx.exec('git', ['ls-remote', '--tags', '--refs', RELEASES], { timeout: 15_000 });
  if (r.missing || r.status !== 0) return out('version', 'skip', `plugin ${ctx.version}; could not reach ${RELEASES}`);
  const tags = r.stdout.split('\n').map((l) => semver(l.split('refs/tags/')[1] ?? '')).filter((v) => v.length === 3);
  if (!tags.length) return out('version', 'skip', `plugin ${ctx.version}; no release tags found`);
  const latest = tags.reduce((a, b) => (newer(b, a) ? b : a));
  const mine = semver(ctx.version);
  return newer(latest, mine) ? out('version', 'warn', `plugin ${ctx.version}; ${latest.join('.')} is out`, 'update the plugin (/plugin in Claude Code), or git pull your skill copy')
    : out('version', 'ok', `plugin ${ctx.version} (latest)`);
}

export function ghCheck(ctx) {
  const v = ctx.exec('gh', ['--version']);
  if (v.missing) return out('gh', 'fail', 'GitHub CLI (gh) not installed', 'install it from cli.github.com, then gh auth login');
  if (!ctx.online) return out('gh', 'skip', 'gh installed; login not checked (offline)');
  const r = ctx.exec('gh', ['auth', 'status', '--hostname', 'github.com']);
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0 || !/Logged in to/i.test(text)) return out('gh', 'fail', 'gh is not logged in to github.com', 'gh auth login');
  // With several accounts, read the active one's block.
  const blocks = text.split(/(?=Logged in to )/i).filter((b) => /Logged in to/i.test(b));
  const active = blocks.find((b) => /Active account:\s*true/i.test(b)) ?? blocks[0];
  const line = /Token scopes:\s*(.*)/i.exec(active);
  if (!line || !line[1].trim() || /none/i.test(line[1])) return out('gh', 'warn', 'gh is logged in, but its scopes cannot be read (fine-grained token?)', 'make sure it can read and write issues, pull requests and projects');
  const scopes = new Set(line[1].match(/[a-z:_]+/gi).map((s) => s.toLowerCase()));
  if (!scopes.has('repo')) return out('gh', 'fail', 'gh token lacks the repo scope (issues, PRs)', 'gh auth refresh -s repo');
  if (!scopes.has('project') && !scopes.has('read:project')) return out('gh', 'warn', 'gh token lacks the project scope (board sync)', 'gh auth refresh -s project');
  return out('gh', 'ok', 'gh logged in with repo and project scopes');
}

export function gitCheck(ctx) {
  const top = ctx.exec('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.project });
  if (top.missing) return out('git', 'fail', 'git not installed', 'install git');
  if (top.status !== 0) return out('git', 'fail', 'not inside a git repo', 'run the coordinator from the project\'s git checkout');
  const remotes = ctx.exec('git', ['remote', '-v'], { cwd: ctx.project }).stdout.split('\n').filter((l) => /\(fetch\)$/.test(l));
  if (!remotes.length) return out('git', 'warn', 'git repo with no remote: state stays local, no PRs', 'git remote add origin <url>');
  const origin = remotes.find((l) => l.startsWith('origin\t')) ?? remotes[0];
  return out('git', 'ok', `git repo, remote ${origin.replace(/\s*\(fetch\)$/, '').replace(/\t/, ' ')}`);
}

// Commands quoted in COORDINATOR.md must still be scripts in package.json.
const BUILTIN = new Set(['install', 'i', 'ci', 'add', 'exec', 'x', 'dlx', 'create', 'init', 'publish', 'version', 'outdated', 'audit', 'ls', 'update', 'remove', 'link', 'pack', 'why', 'config', 'login', 'whoami']);
export function staleCommands(doc, project) {
  const missing = [];
  for (const [, code] of doc.matchAll(/`([^`\n]+)`/g)) {
    for (const m of code.matchAll(/(?:^|&&|;|\|\|)\s*(?:cd\s+([^\s&;]+)\s*&&\s*)?(npm|pnpm|yarn|bun)\s+(run\s+)?([\w:.-]+)/g)) {
      const [, dir, tool, run, script] = m;
      if (!run && (BUILTIN.has(script) || (tool === 'npm' && !['test', 'start', 'stop', 'restart'].includes(script)))) continue;
      const pkg = join(project, dir ?? '', 'package.json');
      let scripts = null;
      try { scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {}; } catch { /* no package.json */ }
      if (!scripts || !(script in scripts)) missing.push(`${dir ? `${dir}: ` : ''}${tool} ${run ? 'run ' : ''}${script}`);
    }
  }
  return [...new Set(missing)];
}

export function contextCheck(ctx) {
  const file = join(ctx.project, 'COORDINATOR.md');
  if (!existsSync(file)) return out('context', 'warn', 'no COORDINATOR.md: every run re-learns the project', '/coordinator:init');
  const doc = readFileSync(file, 'utf8');
  const missing = staleCommands(doc, ctx.project);
  if (missing.length) return out('context', 'warn', `COORDINATOR.md names commands no package.json has: ${missing.join(', ')}`, '/coordinator:init to refresh it');
  const theme = themeFile({}, ctx.project);
  if (theme && !existsSync(theme)) return out('context', 'warn', `COORDINATOR.md Theme: file not found (${rel(ctx.project, theme)})`, 'fix the Theme: line or remove it');
  return out('context', 'ok', 'COORDINATOR.md present; its commands exist');
}

export function stateDirCheck(ctx) {
  const dir = ctx.base;
  const target = existsSync(dir) ? dir : dirname(dir);
  const probe = join(target, `.doctor-${process.pid}-${Date.now()}`);
  try { writeFileSync(probe, ''); rmSync(probe); } catch { return out('state-dir', 'fail', `${rel(ctx.project, dir)} is not writable`, 'fix the folder\'s permissions, or set COORDINATOR_DIR'); }
  const inside = !relative(ctx.project, dir).startsWith('..') && !isAbsolute(relative(ctx.project, dir));
  if (inside) {
    const r = ctx.exec('git', ['check-ignore', '-q', `${rel(ctx.project, dir)}/x`], { cwd: ctx.project });
    if (r.status === 1) return out('state-dir', 'warn', `${rel(ctx.project, dir)}/ is writable but not git-ignored`, 'add .coordinator/ to .gitignore');
  }
  return out('state-dir', 'ok', existsSync(dir) ? `${rel(ctx.project, dir)}/ writable` : `${rel(ctx.project, dir)}/ will be created on the first run`);
}

export function settingsCheck(ctx) {
  const { settings, error, missing } = readSettings(ctx.base);
  if (missing) return [out('settings', 'ok', 'no coordinator.json: built-in defaults'), stateRepoCheck(ctx, {})];
  if (error) return [out('settings', 'fail', `coordinator.json ${error}`, 'fix the file or rerun /coordinator:init')];
  const problems = checkSettings(settings, ctx.project);
  const worst = problems.some((p) => p.level === 'fail') ? 'fail' : problems.length ? 'warn' : 'ok';
  const lines = [worst === 'ok'
    ? out('settings', 'ok', `coordinator.json valid (${Object.keys(settings).join(', ') || 'empty'})`)
    : out('settings', worst, `coordinator.json: ${problems.map((p) => p.text).join('; ')}`, 'edit .coordinator/coordinator.json or rerun /coordinator:init')];
  lines.push(stateRepoCheck(ctx, settings));
  return lines;
}

function stateRepoCheck(ctx, s) {
  if (s.state === 'local') return out('state', 'ok', 'run state stays on this machine (state: local)');
  if (!s.stateRepo) return out('state', 'ok', `run state goes to the ${s.branch ?? 'coordinator-state'} branch of ${s.remote ?? 'origin'} at pit stops (refused if that repo is public)`);
  if (!ctx.online) return out('state', 'skip', 'stateRepo set; its visibility not checked (offline)');
  const r = ctx.exec('gh', ['repo', 'view', s.stateRepo, '--json', 'visibility', '-q', '.visibility']);
  const vis = r.status === 0 ? r.stdout.trim().toLowerCase() : '';
  if (vis === 'public') return out('state', 'fail', 'stateRepo is PUBLIC: run state would be published', 'make it private, or point stateRepo at a private repo');
  if (vis === 'private' || vis === 'internal') return out('state', 'ok', `stateRepo is ${vis}`);
  return out('state', 'warn', 'cannot tell whether stateRepo is private (missing, or no access)', 'gh repo view <stateRepo>; push refuses until it can tell');
}

function walk(dir, depth, hit) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0 && e.name !== 'artifacts') walk(p, depth - 1, hit);
    else if (e.isFile()) hit(p, e.name);
  }
}

export function locksCheck(ctx) {
  const stale = [];
  const now = ctx.now ?? Date.now();
  walk(ctx.base, 4, (p, n) => { if (n.endsWith('.lock')) { try { if (now - statSync(p).mtimeMs > LOCK_STALE_MS) stale.push(rel(ctx.base, p)); } catch { /* gone */ } } });
  return stale.length ? out('locks', 'warn', `stale lock files: ${stale.join(', ')}`, 'delete them when no coordinator command is running')
    : out('locks', 'ok', 'no stale locks');
}

// `run.mjs serve` records { pid, port } in runs/<run>/serve.json while it runs.
export function dashboardsCheck(ctx) {
  const runs = join(ctx.base, 'runs');
  const lines = [];
  let dirs = [];
  try { dirs = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no runs */ }
  for (const run of dirs) {
    const f = join(runs, run, 'serve.json');
    if (!existsSync(f)) continue;
    let rec = null;
    try { rec = JSON.parse(readFileSync(f, 'utf8')); } catch { /* unreadable */ }
    if (!rec || !Number.isInteger(rec.pid)) { lines.push(out('dashboards', 'warn', `unreadable runs/${run}/serve.json`, 'delete it')); continue; }
    if (!(ctx.alive ?? alive)(rec.pid)) { lines.push(out('dashboards', 'warn', `runs/${run}/serve.json names pid ${rec.pid}, which is gone`, `delete runs/${run}/serve.json`)); continue; }
    let closed = false;
    try { closed = !!JSON.parse(readFileSync(join(runs, run, STATE), 'utf8')).closed; } catch { /* no snapshot */ }
    lines.push(closed ? out('dashboards', 'warn', `dashboard for closed run ${run} still holds port ${rec.port} (pid ${rec.pid})`, `stop pid ${rec.pid}`)
      : out('dashboards', 'ok', `dashboard for ${run} on port ${rec.port} (pid ${rec.pid})`));
  }
  return lines.length ? lines : [out('dashboards', 'ok', 'no dashboards running')];
}

// Per run: stored evidence files must still match their sha256 (fail), and files
// the run mentions outside its folder should be adopted before a worktree goes (warn).
export function artifactsCheck(ctx) {
  const runs = join(ctx.base, 'runs');
  let dirs = [];
  try { dirs = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no runs */ }
  const lines = [];
  let tracked = null;
  for (const run of dirs) {
    let s;
    try { s = JSON.parse(readFileSync(join(runs, run, STATE), 'utf8')); } catch { continue; }
    const dir = join(runs, run);
    const bad = verifyStored(s, dir);
    if (bad.length) lines.push(out('artifacts', 'fail', `${run}: stored artifacts ${bad.map((b) => `${b.file} ${b.problem}`).join(', ')}`, 'restore them from a pushed copy (run.mjs pull), or re-add the evidence'));
    tracked ??= ctx.tracked ?? trackedFiles(ctx.project);
    const rows = adopt(s, dir, { project: ctx.project, home: ctx.home, tracked });
    const loose = rows.filter((r) => r.status === 'adoptable').length;
    const gone = rows.filter((r) => r.status === 'missing').length;
    if (loose) lines.push(out('artifacts', 'warn', `${run}: ${loose} file(s) mentioned outside the run folder, not adopted${gone ? ` (${gone} already gone)` : ''}`, `run.mjs adopt ${run}`));
  }
  return lines.length ? lines : [out('artifacts', 'ok', dirs.length ? 'stored artifacts intact; mentioned files adopted' : 'no runs yet')];
}

export function worktreesCheck(ctx) {
  const r = ctx.exec('git', ['worktree', 'list', '--porcelain'], { cwd: ctx.project });
  if (r.missing || r.status !== 0) return out('worktrees', 'skip', 'not a git repo');
  const paths = r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice(9).trim())).slice(1);
  const links = []; const gone = [];
  for (const wt of paths) {
    if (!existsSync(wt)) { gone.push(wt); continue; }
    const candidates = [join(wt, 'node_modules')];
    try { for (const d of readdirSync(wt, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') candidates.push(join(wt, d.name, 'node_modules')); } catch { /* unreadable */ }
    for (const c of candidates) { try { if (lstatSync(c).isSymbolicLink()) links.push(c); } catch { /* none */ } }
  }
  if (links.length) return out('worktrees', 'warn', `node_modules linked into worktrees: ${links.join(', ')} (removing the worktree can delete the linked packages)`, 'unlink first (Windows: cmd /c rmdir <link>; else rm <link>), then npm ci in the worktree');
  if (gone.length) return out('worktrees', 'warn', `${gone.length} worktree(s) missing on disk`, 'git worktree prune');
  return out('worktrees', 'ok', `${paths.length} worktree(s), no linked node_modules`);
}

export function lessonsCheck(ctx) {
  const bad = []; let n = 0;
  for (const base of [...new Set([ctx.globalBase, ctx.base])]) {
    const f = join(base, 'lessons.json');
    if (!existsSync(f)) continue;
    try { const l = JSON.parse(readFileSync(f, 'utf8')); if (!Array.isArray(l)) throw new Error(); n += l.length; } catch { bad.push(f); }
  }
  return bad.length ? out('lessons', 'fail', `lessons file unreadable: ${bad.map((f) => rel(ctx.home, f)).join(', ')}`, 'fix the JSON, or move the file aside to start fresh')
    : out('lessons', 'ok', n ? `${n} lesson(s) readable` : 'no lessons yet');
}

export function codexCheck(ctx) {
  let agents = '';
  try { agents = readFileSync(join(ctx.project, 'AGENTS.md'), 'utf8'); } catch { /* none */ }
  if (!/^## Coordinator\b/m.test(agents)) return out('codex', 'skip', 'no Coordinator block in AGENTS.md (Codex not set up)');
  const root = [join(ctx.project, '.agents', 'skills'), join(ctx.home, '.agents', 'skills')].find((d) => existsSync(join(d, 'coordinator', 'SKILL.md')));
  if (!root) return out('codex', 'fail', 'AGENTS.md has the Coordinator block but no .agents/skills/coordinator', 'copy every folder under skills/ into .agents/skills/ (references/codex.md)');
  const missing = SKILLS.filter((s) => !existsSync(join(root, s, 'SKILL.md')));
  return missing.length ? out('codex', 'warn', `Codex install lacks: ${missing.join(', ')}`, 'copy every folder under skills/ into .agents/skills/ side by side')
    : out('codex', 'ok', 'Codex install has every skill');
}

export function diagnose(ctx) {
  const c = { exec: realExec, online: true, ...ctx };
  return [nodeCheck(c), versionCheck(c), ghCheck(c), gitCheck(c), contextCheck(c), stateDirCheck(c), ...settingsCheck(c), locksCheck(c), ...dashboardsCheck(c), ...artifactsCheck(c), worktreesCheck(c), lessonsCheck(c), codexCheck(c)];
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
export const format = (results) => results.map((r) => `${MARK[r.status]}  ${r.id.padEnd(11)} ${r.text}${r.fix ? `  → ${r.fix}` : ''}`).join('\n');
