// The release-notes draft a run can derive by itself, for the lead to confirm:
// each unit's issues, PRs and merges from the state, and from git, between the
// base and head each unit's gaming check recorded (detect.mjs): the files
// changed, migrations and scripts added, .env.example variables added or
// removed, and lines that schedule or queue jobs. Plus notes that mention copy
// awaiting approval. Nothing here is a fact until the lead confirms it.
import { execFileSync } from 'node:child_process';
import { purpose } from '../plain.mjs';

export const MIGRATION = /(^|\/)(migrations?|drizzle|alembic\/versions|db\/migrate)\/[^/]+\.(sql|ts|js|mjs|py|rb)$|\.prisma$/i;
export const SCRIPT = /(^|\/)(scripts?|bin)\/[^/]+$/;
export const ENV_FILE = /(^|\/)\.env\.(example|sample|template)$/;
export const JOB = /\b(?:boss\.(?:work|schedule|send)|cron\.schedule|schedule\s*\(\s*["'`][\d*/ ,-]+["'`]|(?:queue|Queue)\.(?:add|process)|new\s+(?:Worker|Queue|CronJob)\s*\(|@Cron\(|celery|@shared_task|setInterval\s*\()/;
const COPY = /awaiting (?:copy )?approval|copy (?:studio|sign-?off)|awaiting sign-?off|copy awaiting/i;

export const gitRunner = (root) => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// The files each unit changed, from its recorded base..head. A range git cannot read is reported, not guessed.
export function unitDiffs(run, git) {
  return run.units.map((u) => {
    const { base, head } = u.detect ?? {};
    if (!base || !head) return { unit: u.id, ok: false, why: 'no recorded diff (detect.mjs was not run)', files: [] };
    try {
      const files = git('diff', '--name-status', '--no-renames', base, head).split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { status: st[0], path: p.join('\t') }; });
      return { unit: u.id, ok: true, base, head, files };
    } catch { return { unit: u.id, ok: false, base, head, why: `git cannot read ${base.slice(0, 10)}..${head.slice(0, 10)} here (another repo, or not fetched)`, files: [] }; }
  });
}

export const changedPaths = (diffs) => [...new Set(diffs.flatMap((d) => d.files.filter((f) => f.status !== 'D').map((f) => f.path)))].sort();

function added(git, d, pathspec) {
  try { return git('diff', '-U0', '--no-color', d.base, d.head, '--', ...pathspec).split('\n'); } catch { return []; }
}

export function draft(run, { git }) {
  const diffs = unitDiffs(run, git);
  const links = (u, kind) => (u.links ?? []).filter((l) => l.kind === kind).map((l) => l.url);
  const changes = run.units.map((u) => ({
    unit: u.id, title: u.title ?? purpose(u), status: u.status, issues: links(u, 'issue'), prs: links(u, 'pr'), merges: links(u, 'merge'),
    files: diffs.find((d) => d.unit === u.id)?.files.length ?? 0,
  }));
  const migrations = []; const scripts = []; const env = []; const jobs = [];
  for (const d of diffs.filter((x) => x.ok)) {
    for (const f of d.files) {
      if (f.status === 'A' && MIGRATION.test(f.path)) migrations.push({ unit: d.unit, path: f.path });
      if (f.status === 'A' && SCRIPT.test(f.path)) scripts.push({ unit: d.unit, path: f.path });
    }
    const envFiles = d.files.filter((f) => ENV_FILE.test(f.path)).map((f) => f.path);
    let file = null;
    for (const l of envFiles.length ? added(git, d, envFiles) : []) {
      if (l.startsWith('+++ ')) file = l.slice(6);
      const m = /^([+-])\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
      if (m) env.push({ unit: d.unit, name: m[2], change: m[1] === '+' ? 'added' : 'removed', file }); // names only, never values
    }
    const code = d.files.filter((f) => f.status !== 'D' && /\.(?:[cm]?[jt]sx?|py|rb|go)$/.test(f.path) && !/(^|\/)(__tests__|tests?)\/|\.test\./.test(f.path)).map((f) => f.path);
    file = null;
    for (const l of code.length ? added(git, d, code) : []) {
      if (l.startsWith('+++ ')) file = l.slice(6);
      else if (l.startsWith('+') && JOB.test(l)) jobs.push({ unit: d.unit, file, text: l.slice(1).trim().slice(0, 160) });
    }
  }
  // An env var both added and removed in one run (moved between files) is listed once, as added.
  const envOnce = [...new Map(env.map((e) => [`${e.name}|${e.change}`, e])).values()];
  const copy = (run.notes ?? []).filter((n) => COPY.test(n.text)).map((n) => ({ kind: n.kind, text: n.text, at: n.at }));
  return { at: new Date().toISOString(), changes, diffs: diffs.map(({ files, ...d }) => ({ ...d, files: files.length })), files: changedPaths(diffs), migrations, scripts, env: envOnce, jobs: jobs.slice(0, 40), copy };
}

const list = (xs, fn, none = 'None found in the diffs.') => (xs.length ? xs.map((x) => `- ${fn(x)}`).join('\n') : none);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// The draft as Markdown, in the release-notes sub-skill's format, with TODO where only the lead can write.
export function draftMarkdown(d, run) {
  const refs = (c) => [...c.prs, ...c.merges, ...c.issues].join(', ') || 'no links';
  const done = d.changes.filter((c) => c.status === 'pass');
  const unread = d.diffs.filter((x) => !x.ok);
  return [
    `## ${run.id} · ${d.at.slice(0, 10)}`,
    '',
    'Draft derived by `run.mjs report --draft`: confirm every line against the PRs before storing it.',
    '',
    '### Changes',
    list(done, (c) => `${c.title}: TODO say what changed in plain words (${refs(c)})`, 'No unit passed.'),
    ...(d.changes.length > done.length ? ['', 'Not in this release (not passed): ' + d.changes.filter((c) => c.status !== 'pass').map((c) => `${c.unit} (${c.status})`).join(', ')] : []),
    '',
    '### For testers',
    '| Change | Role and screen | Steps | Expected | Locales / sizes |',
    '| --- | --- | --- | --- | --- |',
    ...done.map((c) => `| ${cell(c.title)} | TODO | TODO | TODO | TODO |`),
    '',
    '### For devops',
    '#### Migrations',
    list(d.migrations, (m) => `\`${m.path}\` (${m.unit})`),
    '#### Environment variables',
    list(d.env, (e) => `\`${e.name}\` ${e.change}${e.file ? ` in \`${e.file}\`` : ''} (${e.unit})`),
    '#### Scripts',
    list(d.scripts, (s) => `\`${s.path}\` added (${s.unit})`),
    '#### Jobs',
    list(d.jobs, (j) => `\`${cell(j.text)}\` in \`${j.file}\` (${j.unit})`),
    '#### Deploy order',
    'TODO',
    '#### Rollback',
    'TODO',
    '#### Copy awaiting approval',
    list(d.copy, (c) => cell(c.text), 'None noted in the run.'),
    ...(unread.length ? ['', `Not read from git: ${unread.map((x) => `${x.unit} (${x.why})`).join('; ')}.`] : []),
    '',
  ].join('\n');
}
