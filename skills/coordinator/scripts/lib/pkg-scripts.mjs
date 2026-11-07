// Which package.json holds each command COORDINATOR.md quotes. A command named with a
// folder (`cd backend && npm run x`, `npm --prefix backend run x`, `npm run x -w backend`,
// `pnpm -C backend x`, `pnpm --filter api x`, `yarn --cwd backend x`, `yarn workspace api x`)
// is looked up in that folder only. Any other (and `pnpm -r`) is looked up in the root
// package.json, its workspaces, and first-level folders that have one (backend/, frontend/).
// A folder outside the project is never read: that command is skipped.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const BUILTIN = new Set(['install', 'i', 'ci', 'add', 'exec', 'x', 'dlx', 'create', 'init', 'publish', 'version', 'outdated', 'audit', 'ls', 'update', 'remove', 'link', 'pack', 'why', 'config', 'login', 'whoami']);
const NPM_LIFECYCLE = ['test', 'start', 'stop', 'restart'];
// Options that take a folder or workspace, per tool. pnpm's -w is the workspace root (no value).
const VALUE_OPTS = { npm: ['--prefix', '-w', '--workspace'], pnpm: ['-C', '--dir', '--filter', '-F'], yarn: ['--cwd'], bun: ['--cwd'] };
const ROOT_FLAGS = { pnpm: ['-w', '--workspace-root'] };
const ALL_FLAGS = { pnpm: ['-r', '--recursive'] };

const tokens = (s) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const norm = (s) => s.replace(/^\.\//, '').replace(/[\\/]+$/, '').replace(/\\/g, '/') || '.';
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const hasPkg = (project, dir) => existsSync(join(project, dir, 'package.json'));
const subdirs = (abs) => { try { return readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name).sort(); } catch { return []; } };
const fileOf = (dir) => (dir === '.' ? 'package.json' : `${dir}/package.json`);

// Workspace folders from the root package.json: an array or { packages: [...] }; `dir/*`
// and `dir/**` expand one level, other entries are taken as paths. Negations are skipped.
function workspaceDirs(project) {
  const ws = readJson(join(project, 'package.json'))?.workspaces;
  const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  const dirs = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.startsWith('!')) continue;
    const entry = norm(raw);
    const glob = /^(.*?)\/\*\*?$/.exec(entry);
    if (glob) dirs.push(...subdirs(join(project, glob[1])).map((d) => `${glob[1]}/${d}`));
    else if (!entry.includes('*')) dirs.push(entry);
  }
  return dirs.filter((d) => hasPkg(project, d));
}

// The package.json folders searched for a command with no folder: root first.
export function packageDirs(project) {
  return [...new Set(['.', ...workspaceDirs(project), ...subdirs(project)])].filter((d) => hasPkg(project, d));
}

// A folder relative to the project, or null when it resolves outside it.
function inside(project, base, dir) {
  const r = relative(project, resolve(project, base, dir));
  return r.startsWith('..') || isAbsolute(r) ? null : norm(r);
}

// One shell segment, after any `cd`: { tool, script, run, dir?, all? } or null.
function parse(words) {
  const tool = words[0];
  if (!VALUE_OPTS[tool]) return null;
  const c = { tool, dirs: [] };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--') break;
    const [opt, eq] = w.split(/=(.*)/s);
    if (VALUE_OPTS[tool].includes(opt)) { const v = eq ?? words[++i]; if (v) c.dirs.push({ v, name: opt !== '--prefix' && opt !== '-C' && opt !== '--dir' && opt !== '--cwd', filter: /^(--filter|-F)$/.test(opt) }); continue; }
    if (ROOT_FLAGS[tool]?.includes(w)) { c.dirs.push({ v: '.' }); continue; }
    if (ALL_FLAGS[tool]?.includes(w)) { c.all = true; continue; }
    if (w.startsWith('-')) continue;
    if (c.script) continue;
    if (tool === 'yarn' && w === 'workspace' && !c.run && words[i + 1]) { c.dirs.push({ v: words[++i], name: true }); continue; }
    if ((w === 'run' || w === 'run-script') && !c.run) { c.run = true; continue; }
    if (!/^[\w:.-]+$/.test(w)) return null;
    c.script = w;
  }
  return c.script ? c : null;
}

// { missing: ['backend: npm run x'], found: { 'backend/package.json': ['npm run y'] },
//   searched: [...], unreadable: [...] }. `found` lists commands found outside the root;
// `unreadable` lists package.json files consulted that are not valid JSON.
export function staleCommands(doc, project) {
  const all = packageDirs(project);
  const missing = new Set(); const searched = new Set(); const unreadable = new Set(); const found = {};
  const cache = new Map();
  const get = (dir) => {
    if (!cache.has(dir)) {
      const file = join(project, dir, 'package.json');
      const json = existsSync(file) ? readJson(file) : undefined;
      if (json === null) unreadable.add(fileOf(dir));
      cache.set(dir, json ? json.scripts ?? {} : null);
    }
    return cache.get(dir);
  };
  const byName = (v) => (hasPkg(project, v) ? v : all.find((d) => readJson(join(project, d, 'package.json'))?.name === v));
  for (const [, code] of doc.matchAll(/`([^`\n]+)`/g)) {
    let cwd = '.';
    for (const seg of code.split(/&&|;|\|\|/)) {
      const words = tokens(seg.trim());
      if (words[0] === 'cd' && words[1]) { cwd = inside(project, '.', join(cwd, words[1])) ?? '..'; continue; }
      const c = parse(words);
      if (!c || (!c.run && (BUILTIN.has(c.script) || (c.tool === 'npm' && !NPM_LIFECYCLE.includes(c.script))))) continue;
      if (cwd === '..') continue;
      let dir = cwd === '.' ? null : cwd; let skip = false;
      for (const o of c.dirs) {
        const named = o.name ? byName(o.v) : undefined;
        if (o.filter && named === undefined) { dir = null; continue; }
        const d = inside(project, dir ?? '.', named ?? o.v);
        if (d === null) skip = true; else dir = d;
      }
      if (skip) continue;
      const name = `${c.tool} ${c.run ? 'run ' : ''}${c.script}`;
      const where = dir && !c.all ? [dir] : all;
      const hit = where.find((d) => { const s = get(d); return s && c.script in s; });
      if (hit === undefined) {
        missing.add(`${dir && !c.all ? `${dir}: ` : ''}${name}`);
        (where.length ? where : ['.']).forEach((d) => searched.add(fileOf(d)));
      } else if (hit !== '.') (found[fileOf(hit)] ??= new Set()).add(name);
    }
  }
  return {
    missing: [...missing], searched: [...searched], unreadable: [...unreadable],
    found: Object.fromEntries(Object.entries(found).map(([f, s]) => [f, [...s]])),
  };
}
