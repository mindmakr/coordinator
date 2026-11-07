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
import { readRegistry } from './registry.mjs';
import { staleCommands } from './pkg-scripts.mjs';

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

export function contextCheck(ctx) {
  const file = join(ctx.project, 'COORDINATOR.md');
  if (!existsSync(file)) return out('context', 'warn', 'no COORDINATOR.md: every run re-learns the project', '/coordinator:init');
  const doc = readFileSync(file, 'utf8');
  // Commands quoted in COORDINATOR.md must still be scripts in a package.json (lib/pkg-scripts.mjs).
  const { missing, searched, found, unreadable } = staleCommands(doc, ctx.project);
  const bad = unreadable.length ? `; could not read ${unreadable.join(', ')} (not valid JSON)` : '';
  if (missing.length) return out('context', 'warn', `COORDINATOR.md names commands no package.json has: ${missing.join(', ')} (searched ${searched.join(', ')})${bad}`, '/coordinator:init to refresh it');
  if (bad) return out('context', 'warn', `COORDINATOR.md commands found${bad.replace(';', ',')}`, 'fix the package.json');
  const theme = themeFile({}, ctx.project);
  if (theme && !existsSync(theme)) return out('context', 'warn', `COORDINATOR.md Theme: file not found (${rel(ctx.project, theme)})`, 'fix the Theme: line or remove it');
  const where = Object.entries(found).map(([file, names]) => `${names.join(', ')} in ${file}`);
  return out('context', 'ok', `COORDINATOR.md present; its commands exist${where.length ? ` (${where.join('; ')})` : ''}`);
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
  const stateBad = problems.filter((p) => p.level === 'fail' && ['state', 'visibility', 'stateRepo', 'remote', 'branch'].includes(p.key));
  const worst = problems.some((p) => p.level === 'fail') ? 'fail' : problems.length ? 'warn' : 'ok';
  const lines = [worst === 'ok'
    ? out('settings', 'ok', `coordinator.json valid (${Object.keys(settings).join(', ') || 'empty'})`)
    : out('settings', worst, `coordinator.json: ${problems.map((p) => p.text).join('; ')}`, 'edit .coordinator/coordinator.json or rerun /coordinator:init')];
  lines.push(stateBad.length ? out('state', 'fail', `run state settings are invalid: ${stateBad.map((p) => p.text).join('; ')}`, 'fix them in .coordinator/coordinator.json; push refuses until then') : stateRepoCheck(ctx, settings));
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
    if (!(ctx.alive ?? alive)(rec.pid)) {
      // Its server is gone, so the record is only stale: remove it, or say how.
      let removed = false;
      if (ctx.fix !== false) { try { rmSync(f); removed = true; } catch { /* leave it */ } }
      lines.push(out('dashboards', removed ? 'ok' : 'warn', removed ? `removed a stale dashboard record for ${run} (pid ${rec.pid} is gone)` : `runs/${run}/serve.json names pid ${rec.pid}, which is gone`, removed ? undefined : `delete ${f}`));
      continue;
    }
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
  const lines = []; const notes = [];
  let tracked = null;
  for (const run of dirs) {
    let s;
    try { s = JSON.parse(readFileSync(join(runs, run, STATE), 'utf8')); } catch { continue; }
    const dir = join(runs, run);
    const bad = verifyStored(s, dir);
    for (const b of bad) {
      const fix = b.sourceExists ? `run.mjs adopt ${run} (copies it again from ${b.source})`
        : b.source ? `the original (${b.source}) is gone: re-run the step that made it, then run.mjs evidence ${run} ${b.unit ?? '--goal'} --file <path>`
          : `re-attach it: run.mjs evidence ${run} ${b.unit ?? '--goal'} --file <the original>`;
      lines.push(out('artifacts', 'fail', `${run}: stored artifact ${b.file} ${b.problem}`, fix));
    }
    tracked ??= ctx.tracked ?? trackedFiles(ctx.project);
    const rows = adopt(s, dir, { project: ctx.project, home: ctx.home, tracked });
    const count = (k) => rows.filter((r) => r.status === k).length;
    const loose = count('adoptable'); const unclear = count('unclear'); const gone = count('missing'); const refused = count('refused');
    if (loose) lines.push(out('artifacts', 'warn', `${run}: ${loose} file(s) mentioned outside the run folder, not adopted${gone ? ` (${gone} already gone)` : ''}`, `run.mjs adopt ${run}`));
    if (unclear) lines.push(out('artifacts', 'warn', `${run}: ${unclear} mentioned path(s) could not be read with certainty (spaces or brackets, not found)`, `run.mjs adopt ${run} --dry-run, then attach each with run.mjs evidence … --file "<path>"`));
    if (!loose && !unclear && (gone || refused)) notes.push(`${run}: ${gone} gone, ${refused} refused`);
  }
  if (lines.length) return lines;
  return [out('artifacts', 'ok', dirs.length ? `stored artifacts intact; nothing left to adopt${notes.length ? ` (${notes.join('; ')})` : ''}` : 'no runs yet')];
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

// Every copy of the coordinator skill this machine and project hold, by the tool that reads it
// (references/harnesses.md). A copy is a folder with coordinator/SKILL.md; its version is in
// scripts/lib/version.mjs, and a copy without scripts/run.mjs cannot keep a run.
const subdirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name)); } catch { return []; } };
export function skillRoots(project, home) {
  const plugin = subdirs(join(home, '.claude', 'plugins', 'cache')).flatMap((m) => subdirs(join(m, 'coordinator')))
    .filter((v) => !existsSync(join(v, '.orphaned_at'))).map((v) => ['claude-code', join(v, 'skills')]);
  return [
    ...plugin, ['claude-code', join(home, '.claude', 'skills')], ['claude-code', join(project, '.claude', 'skills')],
    ['any', join(home, '.agents', 'skills')], ['any', join(project, '.agents', 'skills')],
    ['codex', join(home, '.codex', 'skills')], ['codex', join(project, '.codex', 'skills')],
    ['gemini', join(home, '.gemini', 'skills')], ['gemini', join(project, '.gemini', 'skills')],
    ...subdirs(join(home, '.gemini', 'extensions')).map((x) => ['gemini', join(x, 'skills')]),
    ['antigravity', join(home, '.gemini', 'antigravity', 'skills')], ['antigravity', join(project, '.agent', 'skills')],
  ];
}
export function skillCopies(project, home) {
  const seen = new Set(); const copies = [];
  for (const [harness, root] of skillRoots(project, home)) {
    const dir = join(root, 'coordinator');
    if (!existsSync(join(dir, 'SKILL.md')) || seen.has(resolve(dir).toLowerCase())) continue;
    seen.add(resolve(dir).toLowerCase());
    let version = null;
    try { version = /VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(dir, 'scripts', 'lib', 'version.mjs'), 'utf8'))?.[1] ?? null; } catch { /* older copy */ }
    copies.push({ harness, dir, version, scripts: existsSync(join(dir, 'scripts', 'run.mjs')) });
  }
  return copies;
}

export function copiesCheck(ctx) {
  const copies = ctx.copies ?? skillCopies(ctx.project, ctx.home);
  if (!copies.length) return out('copies', 'ok', `no installed copy found beside this one (skill ${ctx.version})`);
  const where = copies.map((c) => `${rel(ctx.home, c.dir)} ${c.version ?? 'unknown'}${c.scripts ? '' : ' (no scripts)'}`).join('; ');
  const versions = [...new Set([ctx.version, ...copies.map((c) => c.version ?? 'unknown')])];
  return versions.length > 1
    ? out('copies', 'warn', `copies of the skill differ (${versions.join(', ')}): ${where}`, 'update every copy to the same version (references/harnesses.md); a run written by another version shows a warning, it does not break')
    : out('copies', 'ok', `${copies.length} cop${copies.length === 1 ? 'y' : 'ies'}, all ${ctx.version}: ${where}`);
}

// A tool told to use the coordinator (its instructions file names it) that has no copy of the scripts
// would have to write run state by hand, which the skill forbids (runs go only through run.mjs).
const mentions = (f) => { try { return /coordinator/i.test(readFileSync(f, 'utf8')); } catch { return false; } };
const filesIn = (d) => { try { return readdirSync(d).filter((n) => n.endsWith('.md')).map((n) => join(d, n)); } catch { return []; } };
export function harnessesCheck(ctx) {
  const copies = ctx.copies ?? skillCopies(ctx.project, ctx.home);
  const has = (h) => copies.some((c) => c.scripts && (c.harness === h || c.harness === 'any'));
  const told = {
    gemini: [join(ctx.project, 'GEMINI.md'), join(ctx.home, '.gemini', 'GEMINI.md')].filter(mentions),
    antigravity: [join(ctx.project, '.agent', 'rules'), join(ctx.project, '.agent', 'workflows'), join(ctx.project, '.agents', 'rules'), join(ctx.project, '.agents', 'workflows')].flatMap(filesIn).filter(mentions),
  };
  const bad = Object.entries(told).filter(([h, files]) => files.length && !has(h));
  if (bad.length) return bad.map(([h, files]) => out('harnesses', 'warn', `${h} has coordinator instructions (${files.map((f) => rel(ctx.project, f)).join(', ')}) but no copy of the scripts`, 'copy every folder under skills/ where that tool reads skills (references/harnesses.md)'));
  const set = Object.entries(told).filter(([, f]) => f.length).map(([h]) => h);
  return [out('harnesses', 'ok', set.length ? `${set.join(', ')}: instructions and scripts in place` : 'no Gemini or Antigravity instructions name the coordinator')];
}

// The machine-wide register (lib/registry.mjs): every run on this PC, with the tool and skill version that last wrote it.
export function registryCheck(ctx) {
  let runs = [];
  try { runs = readRegistry({ home: ctx.registryHome }); } catch (e) { return out('registry', 'warn', `run register unreadable: ${e.message}`, 'delete it; each run re-registers on its next write'); }
  if (!runs.length) return out('registry', 'ok', 'no run registered on this PC yet');
  const projects = new Set(runs.map((r) => r.key)).size;
  const shown = runs.slice(0, 8).map((r) => `${r.run}${r.alias ? ` "${r.alias}"` : ''} (${r.harness ?? 'tool not recorded'}${r.skill ? ` ${r.skill}` : ''})`).join(', ');
  const other = runs.filter((r) => r.skill && r.skill !== ctx.version);
  const text = `${runs.length} run(s) in ${projects} project(s) on this PC: ${shown}${runs.length > 8 ? ', …' : ''}`;
  return other.length ? out('registry', 'warn', `${text}; ${other.length} last written by another skill version (${[...new Set(other.map((r) => r.skill))].join(', ')})`, 'run.mjs list --all; update the older copies (copies line)')
    : out('registry', 'ok', text);
}

export function diagnose(ctx) {
  const c = { exec: realExec, online: true, ...ctx };
  return [nodeCheck(c), versionCheck(c), ghCheck(c), gitCheck(c), contextCheck(c), stateDirCheck(c), ...settingsCheck(c), locksCheck(c), ...dashboardsCheck(c), ...artifactsCheck(c), worktreesCheck(c), lessonsCheck(c), codexCheck(c), copiesCheck(c), ...harnessesCheck(c), registryCheck(c)];
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
export const format = (results) => results.map((r) => `${MARK[r.status]}  ${r.id.padEnd(11)} ${r.text}${r.fix ? `  → ${r.fix}` : ''}`).join('\n');
