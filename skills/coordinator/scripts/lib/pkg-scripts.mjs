// Which package.json holds each command COORDINATOR.md quotes. A command named with a
// directory (`cd backend && npm run x`, `npm --prefix backend run x`, `pnpm -C backend x`,
// `yarn --cwd backend x`, `npm -w backend run x`) is looked up in that folder only. Any
// other is looked up in the root package.json, its workspaces, and first-level folders
// that have one (backend/, frontend/), so a monorepo's commands are found where they live.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUILTIN = new Set(['install', 'i', 'ci', 'add', 'exec', 'x', 'dlx', 'create', 'init', 'publish', 'version', 'outdated', 'audit', 'ls', 'update', 'remove', 'link', 'pack', 'why', 'config', 'login', 'whoami']);
const NPM_LIFECYCLE = ['test', 'start', 'stop', 'restart'];
const DIR_OPT = /(?:--prefix|--dir|--cwd|--workspace|-C|-w)(?:=|\s+)("[^"]+"|'[^']+'|[^\s&;|]+)/g;
const COMMAND = /(?:^|&&|;|\|\|)\s*(?:cd\s+("[^"]+"|'[^']+'|[^\s&;|]+)\s*&&\s*)?(npm|pnpm|yarn|bun)((?:\s+(?:--prefix|--dir|--cwd|--workspace|-C|-w)(?:=|\s+)(?:"[^"]+"|'[^']+'|[^\s&;|]+))*)\s+(run\s+)?([\w:.-]+)/g;

const unquote = (s) => s.replace(/^["']|["']$/g, '').replace(/^\.\//, '').replace(/[\\/]+$/, '').replace(/\\/g, '/') || '.';
const readScripts = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')).scripts ?? {}; } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const hasPkg = (project, dir) => existsSync(join(project, dir, 'package.json'));
const subdirs = (abs) => { try { return readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name).sort(); } catch { return []; } };

// Workspace folders from the root package.json: an array or { packages: [...] }; `dir/*`
// and `dir/**` expand one level, other entries are taken as paths. Negations are skipped.
function workspaceDirs(project) {
  const ws = readJson(join(project, 'package.json'))?.workspaces;
  const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  const dirs = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.startsWith('!')) continue;
    const entry = unquote(raw);
    const glob = /^(.*?)\/\*\*?$/.exec(entry);
    if (glob) dirs.push(...subdirs(join(project, glob[1])).map((d) => `${glob[1]}/${d}`));
    else if (!entry.includes('*')) dirs.push(entry);
  }
  return dirs.filter((d) => hasPkg(project, d));
}

// The package.json folders searched for a command with no directory: root first.
export function packageDirs(project) {
  const dirs = ['.', ...workspaceDirs(project), ...subdirs(project)];
  return [...new Set(dirs)].filter((d) => hasPkg(project, d));
}

// `-w @acme/api` names a workspace by its package name rather than its folder.
const byName = (project, dirs, v) => (hasPkg(project, v) ? v : dirs.find((d) => readJson(join(project, d, 'package.json'))?.name === v) ?? v);
const fileOf = (dir) => (dir === '.' ? 'package.json' : `${dir}/package.json`);

// { missing: ['backend: npm run x'], found: { 'backend/package.json': ['npm run y'] }, searched: [...] }
// `found` lists only commands found outside the root package.json.
export function staleCommands(doc, project) {
  const all = packageDirs(project);
  const missing = new Set(); const searched = new Set(); const found = {};
  const scripts = new Map();
  const get = (dir) => { if (!scripts.has(dir)) scripts.set(dir, readScripts(join(project, dir, 'package.json'))); return scripts.get(dir); };
  for (const [, code] of doc.matchAll(/`([^`\n]+)`/g)) {
    for (const m of code.matchAll(COMMAND)) {
      const [, cd, tool, opts, run, script] = m;
      if (!run && (BUILTIN.has(script) || (tool === 'npm' && !NPM_LIFECYCLE.includes(script)))) continue;
      const optDirs = [...opts.matchAll(DIR_OPT)].map((o) => byName(project, all, unquote(o[1])));
      const parts = [cd && unquote(cd), ...optDirs].filter(Boolean);
      const dir = parts.length ? parts.join('/').replace(/(^|\/)\.(?=\/|$)/g, '').replace(/^\/+/, '') || '.' : null;
      const name = `${tool} ${run ? 'run ' : ''}${script}`;
      const where = dir ? [dir] : all;
      const hit = where.find((d) => { const s = get(d); return s && script in s; });
      if (hit === undefined) {
        missing.add(`${dir ? `${dir}: ` : ''}${name}`);
        (where.length ? where : ['.']).forEach((d) => searched.add(fileOf(d)));
      } else if (hit !== '.') (found[fileOf(hit)] ??= new Set()).add(name);
    }
  }
  return {
    missing: [...missing],
    searched: [...searched],
    found: Object.fromEntries(Object.entries(found).map(([f, s]) => [f, [...s]])),
  };
}
