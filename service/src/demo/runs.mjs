// The demo's runs: copies of real run folders, made once at start into a temp folder,
// and the "state branch" the demo's fake GitHub serves, written from those copies by
// the skill's own pit stop (push to a folder), exactly as a lead would. The original
// folders are only ever read. Only a run's log, its snapshot and its project map are
// copied: never evidence files, never anything named .env*.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, decide, isSafeId, mapAttach, mapRestore, pullRun, pushRun, workbench } from '../core.mjs';
import { LIMITS } from '../ingest.mjs';

const RUN_MJS = fileURLToPath(new URL('../../../skills/coordinator/scripts/run.mjs', import.meta.url));
// What a copy holds: the log, its snapshot, and the map (staged for the pit stop, and the working one).
const KEEP = [/^events\.jsonl$/, /^state\.json$/, /^pit-stop\/map\/(events\.jsonl|map\.md)$/, /^map\/[^/]+$/];
const SECRETISH = /(^|\/)\.env/i;

function copyRun(from, to) {
  const walk = (d, rel = '') => {
    for (const name of readdirSync(d)) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(d, name));
      if (st.isSymbolicLink() || SECRETISH.test(path)) continue;
      if (st.isDirectory()) walk(join(d, name), path);
      else if (st.isFile() && KEEP.some((re) => re.test(path))) { mkdirSync(dirname(join(to, path)), { recursive: true }); copyFileSync(join(d, name), join(to, path)); }
    }
  };
  walk(from);
}

const repoOfState = (dir) => {
  try { const r = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).repo; return typeof r === 'string' && REPO.test(r) ? r : null; } catch { return null; }
};
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 90) || 'project';

// folders: run folders (<project>/.coordinator/runs/<run>). Copies each into tmp, grouped by
// project; each project becomes one repo: the name a run of it records, else local/<folder>.
// A log over the service's cap (LIMITS.logBytes) is not copied: the service would refuse it.
// → { projects: [{ repo, original, root, base, branch, runs: [{ id, dir, original }] }], skipped: ['run: why'] }
export function copyRuns(folders, tmp) {
  const projects = new Map();
  const skipped = [];
  for (const raw of folders) {
    const from = resolve(raw);
    const id = basename(from);
    if (!existsSync(join(from, 'events.jsonl'))) throw new Error(`not a run folder (no events.jsonl): ${from}`);
    if (!isSafeId(id)) throw new Error(`not a run id: ${id}`);
    const size = statSync(join(from, 'events.jsonl')).size;
    if (size > LIMITS.logBytes) { skipped.push(`${id}: its log is ${(size / 2 ** 20).toFixed(1)} MB, over the service's ${LIMITS.logBytes / 2 ** 20} MB cap`); continue; }
    const base = dirname(dirname(from)); // <project>/.coordinator
    const original = dirname(base);
    if (!projects.has(original)) {
      const i = projects.size + 1;
      const root = join(tmp, `project-${i}`);
      projects.set(original, { repo: null, original, root, base: join(root, '.coordinator'), branch: join(tmp, `branch-${i}`), runs: [] });
      // The pit stop asks GitHub whether a repo is public when its target folder sits inside the project
      // (the temp folder can be inside it). The copy says private, so it never asks.
      mkdirSync(join(root, '.coordinator'), { recursive: true });
      writeFileSync(join(root, '.coordinator', 'coordinator.json'), '{ "visibility": "private" }\n');
    }
    const p = projects.get(original);
    if (p.runs.some((r) => r.id === id)) throw new Error(`run ${id} given twice`);
    const dir = join(p.base, 'runs', id);
    copyRun(from, dir);
    p.repo ??= repoOfState(dir);
    p.runs.push({ id, dir, original: from });
  }
  const names = new Set();
  for (const p of projects.values()) {
    let name = p.repo ?? `local/${slug(basename(p.original))}`;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${p.repo ?? `local/${slug(basename(p.original))}`}-${n}`;
    names.add(name.toLowerCase());
    p.repo = name;
    mkdirSync(p.branch, { recursive: true });
  }
  return { projects: [...projects.values()], skipped };
}

// The pit stop: the run's log (masked by the skill's own redactor, the original project
// path shown as "."), snapshot, README and map, written into the project's branch folder.
export const pitStop = (p, run) => pushRun({
  run: run.id, dir: run.dir, base: p.base, project: p.original, to: p.branch,
  render: (s) => workbench(s, decide(s)), attach: [mapAttach(run.dir)],
});

// The lead's pull from the branch folder: answers and notes made on the web join the copy.
export const pullFrom = (p, run) => pullRun({ run: run.id, dir: run.dir, base: p.base, project: p.original, from: p.branch, after: () => {}, restore: { map: mapRestore(run.dir) } });

// Every file of a folder, as { 'a/b': Buffer }.
export function readFolder(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (lstatSync(f).isDirectory()) walk(f); else out[relative(root, f).split('\\').join('/')] = readFileSync(f); } };
  walk(root);
  return out;
}
export function writeFolder(root, files) {
  rmSync(root, { recursive: true, force: true });
  for (const [p, b] of files) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), b); }
}

// The lead asks a question on a copied run, with the skill's own CLI (the copy only).
export function leadAsks(p, run, { question, header, options }) {
  const r = spawnSync(process.execPath, [RUN_MJS, 'ask', run.id, '--question', question, '--header', header, ...options.flatMap((o) => ['--option', o])], {
    cwd: p.root, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', COORDINATOR_DIR: p.base }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`the lead could not ask: ${String(r.stderr).trim().split('\n').at(-1)}`);
  return JSON.parse(r.stdout).asked;
}
