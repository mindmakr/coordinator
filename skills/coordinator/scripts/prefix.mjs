#!/usr/bin/env node
// The fixed prompt prefix every agent turn re-sends, per project (references/context.md, rule 7):
// measure what loads, draft a local trim, and write it only when the person agreed.
//
//   prefix.mjs report [--project <dir>] [--json]
//       enabled plugins (user, project and local settings), user skills (~/.claude/skills), project
//       skills, MCP servers (.mcp.json and the user config, names only), with counts and the skills'
//       description characters. The token figure is /context in a session of the project.
//   prefix.mjs draft [--project <dir>] [--keep a,b] [--claude-ai] [--json]
//       prints .claude/settings.local.json merged into the existing file (no key dropped, no value
//       changed) that turns off the plugins and user skills not kept. Kept: coordinator, the plugins the
//       project's .claude/settings.json turns on, plugins whose MCP server .mcp.json names, and every
//       plugin or skill named with --keep. MCP servers are never turned off. --claude-ai adds
//       syncClaudeAiSkills: false, syncClaudeAiPlugins: false and disableClaudeAiConnectors: true.
//       Writes nothing.
//   prefix.mjs write [--project <dir>] [--keep a,b] [--claude-ai] --confirm [--json]
//       writes that draft and adds .claude/settings.local.json to .git/info/exclude. Refuses without
//       --confirm. Never writes the user-level ~/.claude/settings.json.
//
//   --project  the project folder (default: the git top level of the current folder, else the folder)
//   Plugin changes load only in a new Claude process; /clear reloads skill overrides but keeps the old
//   plugins. To undo, delete the keys or the file.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { helpAndExit, parse } from './lib/args.mjs';
import { draft, draftText, measure, summary, writeTrim } from './lib/prefix.mjs';

helpAndExit(import.meta.url);

function topLevel() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return process.cwd(); }
}

try {
  const { pos, opt } = parse(process.argv.slice(2), ['project', 'keep', 'claude-ai', 'confirm', 'json'], ['keep']);
  const [cmd, extra] = pos;
  if (!['report', 'draft', 'write'].includes(cmd)) throw new Error('give report, draft or write (see --help)');
  if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
  for (const f of ['claude-ai', 'confirm', 'json']) if (opt[f] !== undefined && opt[f] !== true) throw new Error(`--${f} takes no value`);
  if (opt.project === true) throw new Error('--project needs a folder');
  if ((opt.keep ?? []).some((k) => k === true)) throw new Error('--keep needs a list: --keep a,b');
  if (cmd === 'report' && (opt.keep || opt['claude-ai'] || opt.confirm)) throw new Error('report takes only --project and --json');
  if (cmd === 'draft' && opt.confirm) throw new Error('draft writes nothing; use write --confirm');
  const project = resolve(opt.project ?? topLevel());
  const home = homedir();
  const keep = (opt.keep ?? []).flatMap((k) => k.split(','));
  const claudeAi = opt['claude-ai'] === true;
  if (cmd === 'report') {
    const m = measure({ project, home });
    console.log(opt.json ? JSON.stringify({ ...m, summary: summary(m) }, null, 2) : summary(m));
  } else if (cmd === 'draft') {
    const d = draft({ project, home, keep, claudeAi });
    console.log(opt.json ? JSON.stringify(d, null, 2) : draftText(d));
  } else {
    const w = writeTrim({ project, home, keep, claudeAi, confirm: opt.confirm === true });
    const after = measure({ project, home }).counts;
    console.log(opt.json ? JSON.stringify({ ...w, after }, null, 2)
      : `wrote ${w.written}: ${w.off.plugins.length} plugins and ${w.off.skills.length} skills off; ${w.exclude ? `excluded in ${w.exclude}` : 'not a git repo, nothing excluded'}\n`
        + `skills ${w.before.skills} -> ${after.skills}, plugins ${w.before.plugins} -> ${after.plugins}. Start a new Claude process for the plugin changes (/clear keeps the old plugins).`);
  }
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
