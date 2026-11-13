// prefix.mjs: measures what loads for a project from a fake home and project (a linked skill folder
// included), drafts a merged local trim that keeps what the project names, and writes it only with
// --confirm, never touching the user-level settings file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { draft, measure, skillDescription, writeTrim } from '../lib/prefix.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'prefix.mjs');
const root = mkdtempSync(join(tmpdir(), 'coord-prefix-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2)); };
const skill = (dir, description) => put(join(dir, 'SKILL.md'), `---\nname: x\ndescription: ${description}\n---\n\n# body\n`);

// A fake home and project: 3 user skills (one through a link), a dot folder, `synced`, a stray file;
// 5 plugins on (one only in the project file), 1 off; MCP servers in .mcp.json and the user config.
function setup() {
  const base = join(root, `s${++n}`);
  const home = join(base, 'home'); const project = join(base, 'project'); const cache = join(base, 'cache');
  const skills = join(home, '.claude', 'skills');
  skill(join(skills, 'alpha'), 'Alpha skill.');                   // 12
  skill(join(skills, 'beta'), '"Beta, quoted."');                 // 13
  skill(join(base, 'elsewhere', 'gamma'), 'Gamma lives elsewhere.'); // 22
  symlinkSync(join(base, 'elsewhere', 'gamma'), join(skills, 'gamma'), 'junction');
  skill(join(skills, '.hidden'), 'not counted');
  skill(join(skills, 'synced', 'one'), 'not counted');
  put(join(skills, 'notes.txt'), 'a file, not a skill');
  put(join(home, '.claude', 'settings.json'), { theme: 'dark', enabledPlugins: { 'coordinator@coordinator': true, 'ecc@ecc': true, 'reins@reins': true, 'docs@market': true, 'old@market': false } });
  const plugins = {};
  for (const [id, count] of [['coordinator@coordinator', 2], ['ecc@ecc', 5], ['reins@reins', 1], ['docs@market', 0], ['superpowers@official', 3]]) {
    const dir = join(cache, id.replace('@', '-'));
    for (let i = 0; i < count; i++) skill(join(dir, 'skills', `s${i}`), 'abcd'); // 4 each
    plugins[id] = [{ scope: 'user', installPath: dir }];
  }
  put(join(cache, 'docs-market', 'commands', 'write-docs.md'), '---\ndescription: >\n  Write the\n  docs.\n---\n'); // 15
  put(join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins });
  put(join(home, '.claude.json'), { mcpServers: { userone: { command: 'secret-cmd', env: { TOKEN: 'sekrit-value' } } }, projects: { [project.replace(/\\/g, '/')]: { mcpServers: { ownserver: { command: 'x' } } } } });
  put(join(project, '.claude', 'settings.json'), { enabledPlugins: { 'superpowers@official': true } });
  put(join(project, '.mcp.json'), { mcpServers: { reins: { command: 'npx', args: ['reins', 'bridge'] } } });
  spawnSync('git', ['init', '-q'], { cwd: project });
  return { home, project };
}
const run = (ctx, ...args) => {
  const env = { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home };
  return spawnSync(process.execPath, [script, ...args, '--project', ctx.project], { env, encoding: 'utf8' });
};

test('skillDescription reads plain, quoted and folded values', () => {
  const d = join(root, 'desc');
  put(join(d, 'a.md'), '---\nname: a\ndescription: "Hello there"\n---\n');
  put(join(d, 'b.md'), '---\ndescription: |\n  line one\n  line two\nname: b\n---\n');
  put(join(d, 'c.md'), 'no front matter');
  assert.equal(skillDescription(join(d, 'a.md')), 'Hello there');
  assert.equal(skillDescription(join(d, 'b.md')), 'line one line two');
  assert.equal(skillDescription(join(d, 'c.md')), '');
  assert.equal(skillDescription(join(d, 'missing.md')), '');
});

test('report: plugins from every layer, user skills through links, MCP names, counts and characters', () => {
  const s = setup();
  const m = measure(s);
  assert.deepEqual(m.skills.user.map((x) => x.name), ['alpha', 'beta', 'gamma'], 'the linked folder counts; dot names, synced and files do not');
  assert.deepEqual(m.plugins.filter((p) => p.enabled).map((p) => `${p.id}:${p.from}:${p.skills}`),
    ['coordinator@coordinator:user:2', 'docs@market:user:1', 'ecc@ecc:user:5', 'reins@reins:user:1', 'superpowers@official:project:3']);
  assert.deepEqual(m.mcpServers, { project: ['reins'], user: ['ownserver', 'userone'] });
  assert.deepEqual(m.counts, {
    plugins: 5, pluginsOff: 1, skills: 15, userSkills: 3, userSkillsOff: 0, pluginSkills: 12, projectSkills: 0,
    descriptionChars: 12 + 13 + 22 + 11 * 4 + 15, mcpServers: 3,
  });
  assert.equal(m.localTrim, false);
  assert.equal(m.contextTokens, null);

  const r = run(s, 'report', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.counts.skills, 15);
  assert.match(out.summary, /5 plugins, 15 skills \(106 description characters\), 3 MCP servers/);
  const text = run(s, 'report');
  assert.match(text.stdout, /user skills \(~\/\.claude\/skills\): 3 on, 0 off/);
  assert.match(text.stdout, /\/context/);
  for (const o of [r.stdout, text.stdout]) assert.ok(!/secret-cmd|sekrit-value/.test(o), 'an MCP server\'s command or env is never printed');
});

test('draft: keeps coordinator, what the project names and --keep; merges into the local file; writes nothing', () => {
  const s = setup();
  const local = join(s.project, '.claude', 'settings.local.json');
  put(local, { permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'ecc@ecc': true }, skillOverrides: { alpha: 'on' } });
  const before = readFileSync(local, 'utf8');
  const d = draft({ ...s, keep: ['beta'] });
  assert.deepEqual(d.kept.plugins.map((p) => p.id).sort(), ['coordinator@coordinator', 'ecc@ecc', 'reins@reins', 'superpowers@official']);
  assert.deepEqual(d.off.plugins, ['docs@market']);
  assert.deepEqual(d.off.skills, ['gamma'], 'alpha is already set locally, beta is kept');
  assert.deepEqual(d.settings, {
    permissions: { allow: ['Bash(ls)'] },
    enabledPlugins: { 'ecc@ecc': true, 'docs@market': false },
    skillOverrides: { alpha: 'on', gamma: 'off' },
  });
  assert.ok(!('syncClaudeAiSkills' in d.settings) && !('disableClaudeAiConnectors' in d.settings), 'claude.ai keys only when asked');
  const asked = draft({ ...s, claudeAi: true });
  assert.equal(asked.settings.syncClaudeAiSkills, false);
  assert.equal(asked.settings.syncClaudeAiPlugins, false);
  assert.equal(asked.settings.disableClaudeAiConnectors, true);
  assert.deepEqual(draft({ ...s, keep: ['docs'] }).off.plugins, [], 'a plugin kept by its short name');

  const r = run(s, 'draft', '--json', '--keep', 'beta,docs@market');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.off, { plugins: [], skills: ['gamma'], claudeAi: false });
  const text = run(s, 'draft', '--claude-ai');
  assert.match(text.stdout, /nothing written/);
  assert.match(text.stdout, /new Claude process/);
  assert.match(text.stdout, /"disableClaudeAiConnectors": true/);
  assert.equal(readFileSync(local, 'utf8'), before, 'draft writes nothing');
  assert.match(run(s, 'draft', '--confirm').stderr, /writes nothing/);
});

test('write: refuses without --confirm, writes the local file and one exclude line with it, never the user settings', () => {
  const s = setup();
  const userFile = join(s.home, '.claude', 'settings.json');
  const userBefore = readFileSync(userFile, 'utf8');
  const local = join(s.project, '.claude', 'settings.local.json');
  const refused = run(s, 'write');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /needs --confirm/);
  assert.equal(existsSync(local), false, 'nothing written without --confirm');
  assert.throws(() => writeTrim({ ...s, confirm: undefined }), /needs --confirm/);
  assert.throws(() => writeTrim({ project: s.home, home: s.home, confirm: true }), /never the user-level/);

  const ok = run(s, 'write', '--confirm', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  const written = JSON.parse(readFileSync(local, 'utf8'));
  assert.deepEqual(written, { enabledPlugins: { 'docs@market': false, 'ecc@ecc': false }, skillOverrides: { alpha: 'off', beta: 'off', gamma: 'off' } });
  assert.equal(out.after.skills, 15 - 3 - 1 - 5, 'user skills, docs and ecc off');
  const exclude = readFileSync(join(s.project, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(/\r?\n/).filter((l) => l === '.claude/settings.local.json').length, 1);
  assert.equal(run(s, 'write', '--confirm').status, 0, 'a second write is fine');
  assert.equal(readFileSync(join(s.project, '.git', 'info', 'exclude'), 'utf8'), exclude, 'the exclude line is added once');
  assert.equal(readFileSync(userFile, 'utf8'), userBefore, 'the user-level settings file is unchanged');
  assert.equal(measure(s).localTrim, true);
});

test('the CLI refuses bad arguments', () => {
  const s = setup();
  assert.match(run(s).stderr, /report, draft or write/);
  assert.match(run(s, 'report', '--keep', 'x').stderr, /only --project/);
  assert.match(run(s, 'draft', '--bogus').stderr, /unknown option/);
});
