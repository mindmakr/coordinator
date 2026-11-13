// The fixed prompt prefix every agent turn re-sends (references/context.md, rule 7): what loads for
// one project, and a per-project trim. Reads Claude Code's settings layers (user ~/.claude/settings.json,
// project .claude/settings.json, local .claude/settings.local.json), the user skills under
// ~/.claude/skills, the plugin cache's installed_plugins.json, and MCP server names from the project's
// .mcp.json and the user config ~/.claude.json. Only names and counts leave this module: never an MCP
// server's command, arguments or environment. The one write is the project's local settings file and
// its .git/info/exclude line; the user-level settings file is never written.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeJson } from './store.mjs';

export const LOCAL = '.claude/settings.local.json';
// A project that loads more skills than this with no local trim gets a doctor warning.
export const MANY_SKILLS = 30;
// The setup plugin: always kept.
const SETUP = 'coordinator';
const CLAUDE_AI = { syncClaudeAiSkills: false, syncClaudeAiPlugins: false, disableClaudeAiConnectors: true };

// A UTF-8 byte order mark (Windows editors write one) is not part of the JSON.
const parse = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));
const json = (f) => { try { return parse(readFileSync(f, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } }; // statSync follows links and junctions
const plain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const obj = (v) => (plain(v) ? v : {});

// One settings file: { data, error }. A missing file is empty; a file that is there but is not a JSON
// object (bad JSON, a trailing comma, an array) has an error, so nothing ever merges into it as if empty.
export function readSettings(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { data: {}, error: null } : { data: {}, error: `cannot be read (${e.code ?? e.message})` };
  }
  let v;
  try { v = parse(text); } catch (e) { return { data: {}, error: `is not valid JSON (${e.message})` }; }
  return plain(v) ? { data: v, error: null } : { data: {}, error: 'is not a JSON object' };
}

// Why the local file cannot take a merged draft without losing a key, or null when it can.
function localProblem(local) {
  if (local.error) return local.error;
  for (const k of ['enabledPlugins', 'skillOverrides']) if (k in local.data && !plain(local.data[k])) return `has ${k} that is not an object`;
  return null;
}
const shortName = (id) => String(id).split('@')[0];
const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// The description in a SKILL.md's front matter, folded (`>`, `|`) or quoted values included.
export function skillDescription(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description\s*:/.test(l));
  if (i < 0) return '';
  const first = lines[i].replace(/^description\s*:\s*/, '').trim();
  // Indented lines after the key continue the value: a block (`>`, `|`), or a plain or quoted value
  // that wraps. Each line break counts as one character.
  const more = [];
  for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || lines[j].trim() === ''); j++) more.push(lines[j].trim());
  while (more.length && more[more.length - 1] === '') more.pop();
  const block = /^[>|][+-]?\d?$/.test(first);
  const value = (block ? more : [first, ...more]).filter((l) => l !== '').join(' ').trim();
  return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

// Skill folders in one root: real folders and links to folders, without dot names and `synced`.
export function skillFolders(root) {
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && n !== 'synced' && isDir(join(root, n))).sort()
    .map((name) => ({ name, chars: skillDescription(join(root, name, 'SKILL.md')).length }));
}

function commandFiles(root) {
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort().map((n) => ({ name: n.slice(0, -3), chars: skillDescription(join(root, n)).length }));
}

export function layers(project, home) {
  return [
    ['user', join(home, '.claude', 'settings.json')],
    ['project', join(project, '.claude', 'settings.json')],
    ['local', join(project, '.claude', 'settings.local.json')],
  ].map(([scope, file]) => ({ scope, file, ...readSettings(file) }));
}

// Where an installed plugin lives: the entry for this project first, then the user-wide one.
function installPath(installed, id, project) {
  const entries = Array.isArray(installed?.plugins?.[id]) ? installed.plugins[id] : [];
  const here = entries.find((e) => e?.projectPath && norm(e.projectPath) === norm(project));
  const pick = here ?? entries.find((e) => e?.scope === 'user') ?? entries[0];
  return typeof pick?.installPath === 'string' ? pick.installPath : null;
}

// User MCP servers: the top-level ones and this project's entry in ~/.claude.json. Names only.
function userMcp(home, project) {
  const cfg = obj(json(join(home, '.claude.json')));
  const own = Object.entries(obj(cfg.projects)).find(([k]) => norm(k) === norm(project))?.[1];
  return [...new Set([...Object.keys(obj(cfg.mcpServers)), ...Object.keys(obj(own?.mcpServers))])].sort();
}

// What loads for this project, by source, with counts.
export function measure({ project, home }) {
  const ls = layers(project, home);
  const plugins = new Map();
  for (const l of ls) for (const [id, on] of Object.entries(obj(l.data.enabledPlugins))) plugins.set(id, { id, enabled: on === true, from: l.scope });
  const overrides = Object.assign({}, ...ls.map((l) => obj(l.data.skillOverrides)));
  const installed = json(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const pluginList = [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id)).map((p) => {
    if (!p.enabled) return p;
    const dir = installPath(installed, p.id, project);
    // A plugin's skills/ folders and its commands/*.md both list as skills in the prefix.
    const skills = dir ? [...skillFolders(join(dir, 'skills')), ...commandFiles(join(dir, 'commands'))] : null;
    return { ...p, skills: skills ? skills.length : null, chars: skills ? skills.reduce((n, s) => n + s.chars, 0) : null };
  });
  const user = skillFolders(join(home, '.claude', 'skills')).map((s) => ({ ...s, off: overrides[s.name] === 'off' }));
  const projectSkills = skillFolders(join(project, '.claude', 'skills'));
  const projectMcp = Object.keys(obj(json(join(project, '.mcp.json'))?.mcpServers)).sort();
  const userServers = userMcp(home, project);
  const merged = Object.assign({}, ...ls.map((l) => l.data));
  const on = pluginList.filter((p) => p.enabled);
  const userOn = user.filter((s) => !s.off);
  const pluginSkills = on.reduce((n, p) => n + (p.skills ?? 0), 0);
  const local = ls[2].data;
  return {
    project,
    plugins: pluginList,
    skills: { user, project: projectSkills },
    mcpServers: { project: projectMcp, user: userServers },
    claudeAi: Object.fromEntries(Object.keys(CLAUDE_AI).map((k) => [k, merged[k] ?? null])),
    // A trim turns something off; a local file that only turns plugins or skills on is not one.
    localTrim: Object.values(obj(local.enabledPlugins)).some((v) => v === false) || Object.values(obj(local.skillOverrides)).some((v) => v === 'off'),
    unreadable: ls.filter((l) => l.error).map((l) => ({ scope: l.scope, file: l.file, error: l.error })),
    counts: {
      plugins: on.length,
      pluginsOff: pluginList.length - on.length,
      skills: userOn.length + pluginSkills + projectSkills.length,
      userSkills: userOn.length,
      userSkillsOff: user.length - userOn.length,
      pluginSkills,
      projectSkills: projectSkills.length,
      descriptionChars: userOn.reduce((n, s) => n + s.chars, 0) + on.reduce((n, p) => n + (p.chars ?? 0), 0) + projectSkills.reduce((n, s) => n + s.chars, 0),
      mcpServers: new Set([...projectMcp, ...userServers]).size,
    },
    contextTokens: null,
    note: 'counts from settings and folders; the token figure is /context in a Claude Code session of this project',
  };
}

export function summary(m) {
  const c = m.counts;
  const on = m.plugins.filter((p) => p.enabled);
  return [
    `prefix for ${m.project}: ${c.plugins} plugins, ${c.skills} skills (${c.descriptionChars} description characters), ${c.mcpServers} MCP servers`,
    `plugins on: ${on.map((p) => `${p.id} [${p.from}${p.skills === null ? '' : `, ${p.skills} skills`}]`).join(', ') || 'none'}${c.pluginsOff ? `; ${c.pluginsOff} off` : ''}`,
    `user skills (~/.claude/skills): ${c.userSkills} on, ${c.userSkillsOff} off; project skills: ${c.projectSkills}; plugin skills: ${c.pluginSkills}`,
    `MCP servers: project .mcp.json ${m.mcpServers.project.join(', ') || 'none'}; user config ${m.mcpServers.user.join(', ') || 'none'}`,
    `local trim (${LOCAL}): ${m.localTrim ? 'yes' : 'no'}; tokens: not measured here, run /context in a session of this project`,
    ...m.unreadable.map((u) => `not counted: the ${u.scope} settings ${u.file} ${u.error}`),
  ].join('\n');
}

// The merged local settings file that turns off what is not kept. Existing keys and values always stay:
// a plugin or skill the local file already sets is left as set. MCP servers are never turned off here.
export function draft({ project, home, keep = [], claudeAi = false }) {
  const m = measure({ project, home });
  const ls = layers(project, home);
  const problem = localProblem(ls[2]);
  if (problem) throw new Error(`${ls[2].file} ${problem}: fix or remove it first; nothing is drafted or written over it, so none of its keys is lost`);
  const current = ls[2].data;
  const names = new Set(keep.map((k) => String(k).trim()).filter(Boolean));
  const projectPlugins = Object.entries(obj(ls[1].data.enabledPlugins)).filter(([, v]) => v === true).map(([id]) => id);
  const mcpNames = new Set(m.mcpServers.project);
  const why = new Map();
  for (const p of m.plugins.filter((x) => x.enabled)) {
    const s = shortName(p.id);
    if (s === SETUP) why.set(p.id, 'the setup plugin');
    else if (projectPlugins.includes(p.id)) why.set(p.id, 'named in .claude/settings.json');
    else if (mcpNames.has(s)) why.set(p.id, 'its MCP server is in .mcp.json');
    else if (names.has(p.id) || names.has(s)) why.set(p.id, 'given with --keep');
    else if (obj(current.enabledPlugins)[p.id] === true) why.set(p.id, 'already on in the local file');
  }
  const pluginsOff = m.plugins.filter((p) => p.enabled && !why.has(p.id) && !(p.id in obj(current.enabledPlugins))).map((p) => p.id);
  const skillsKept = m.skills.user.filter((s) => !s.off && names.has(s.name)).map((s) => s.name);
  const skillsOff = m.skills.user.filter((s) => !s.off && !names.has(s.name) && !(s.name in obj(current.skillOverrides))).map((s) => s.name);
  const settings = { ...current };
  if (pluginsOff.length || current.enabledPlugins !== undefined) settings.enabledPlugins = { ...obj(current.enabledPlugins), ...Object.fromEntries(pluginsOff.map((id) => [id, false])) };
  if (skillsOff.length || current.skillOverrides !== undefined) settings.skillOverrides = { ...obj(current.skillOverrides), ...Object.fromEntries(skillsOff.map((n) => [n, 'off'])) };
  if (claudeAi) Object.assign(settings, CLAUDE_AI);
  return {
    file: join(project, '.claude', 'settings.local.json'),
    kept: {
      plugins: [...why].map(([id, reason]) => ({ id, reason })),
      skills: skillsKept,
      projectSkills: m.skills.project.map((s) => s.name),
      mcpServers: [...new Set([...m.mcpServers.project, ...m.mcpServers.user])].sort(),
    },
    off: { plugins: pluginsOff, skills: skillsOff, claudeAi },
    before: m.counts,
    settings,
  };
}

export function draftText(d) {
  return [
    `draft for ${d.file} (nothing written; write it with: prefix.mjs write --confirm, same options)`,
    `keep plugins: ${d.kept.plugins.map((p) => `${p.id} (${p.reason})`).join(', ') || 'none'}`,
    `turn off: ${d.off.plugins.length} plugins (${d.off.plugins.join(', ') || 'none'}), ${d.off.skills.length} user skills${d.kept.skills.length ? `; keep skills ${d.kept.skills.join(', ')}` : ''}`,
    `MCP servers are not changed: ${d.kept.mcpServers.join(', ') || 'none'}; claude.ai sync and connectors ${d.off.claudeAi ? 'off' : 'unchanged (add --claude-ai to turn them off)'}`,
    'plugins change only in a new Claude process; /clear reloads skill overrides but keeps the old plugins. To undo, delete the keys or the file.',
    '',
    JSON.stringify(d.settings, null, 2),
  ].join('\n');
}

// Writes the draft and the exclude line. Refuses without confirm, and refuses any target that is a user-level file.
export function writeTrim({ project, home, keep, claudeAi, confirm, exec = execFileSync }) {
  if (confirm !== true) throw new Error('write needs --confirm: show the person the draft first (prefix.mjs draft) and write only after they agree');
  if (norm(project) === norm(home)) throw new Error('the project is the home folder: this writes a project\'s local file only, never the user-level settings');
  if (!isDir(project)) throw new Error(`the project is not a folder: ${project}`);
  const d = draft({ project, home, keep, claudeAi });
  if (norm(d.file) === norm(join(home, '.claude', 'settings.json'))) throw new Error('refusing to write the user-level settings file');
  writeJson(d.file, d.settings);
  const git = (args) => exec('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let exclude = null; let line = null;
  try {
    exclude = resolve(project, git(['rev-parse', '--git-path', 'info/exclude']).trim());
    line = excludeLine(git(['rev-parse', '--show-prefix']).trim());
  } catch { exclude = null; line = null; /* not a git repo: nothing to exclude */ }
  let ignored = false;
  if (exclude) {
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    mkdirSync(dirname(exclude), { recursive: true });
    const same = new Set([line, line.replace(/^\//, '')]);
    if (!text.split(/\r?\n/).some((l) => same.has(l.trim()))) appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
    // Report what git does, not what was meant: a file git already tracks is not hidden by an exclude line.
    try { git(['check-ignore', '-q', d.file]); ignored = true; } catch { ignored = false; }
  }
  return { ...d, written: d.file, exclude, excludeLine: line, ignored };
}

// The exclude line for the local file of a project at `prefix` (git rev-parse --show-prefix) in its
// repository. Patterns in .git/info/exclude are relative to the top level, so a project in a subfolder
// gets its own anchored path, with git's pattern characters escaped.
export function excludeLine(prefix) {
  return prefix ? `/${prefix.replace(/[\\*?[\]]/g, '\\$&')}${LOCAL}` : LOCAL;
}
