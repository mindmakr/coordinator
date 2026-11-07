// Which tool wrote a run, and with which copy of the skill. Every write stamps
// the run with { harness, skill } (lib/events.mjs), so a run started in another
// tool, or by an older or newer copy, says so on its pages instead of looking lost.
//
// The harness comes from --harness, else COORDINATOR_HARNESS, else the
// environment: the variables each tool sets for the commands it runs. Detection
// is a best guess; --harness or COORDINATOR_HARNESS always win (references/harnesses.md).
import { VERSION } from './version.mjs';

export const NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini CLI', cursor: 'Cursor', unknown: 'an unknown tool' };
const SLUG = /^[a-z][a-z0-9-]{0,31}$/;

// What the environment says, in this order: a tool's own marker beats the editor it runs in
// (Claude Code or Gemini CLI inside Antigravity's terminal is Claude Code or Gemini CLI).
export function detect(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (Object.keys(env).some((k) => k.startsWith('CODEX_') && k !== 'CODEX_HOME')) return 'codex';
  if (env.GEMINI_CLI) return 'gemini';
  const hint = [env.TERM_PROGRAM, env.__CFBundleIdentifier, env.VSCODE_GIT_ASKPASS_NODE, env.VSCODE_IPC_HOOK_CLI, env.VSCODE_CWD]
    .filter(Boolean).join(' ');
  if (Object.keys(env).some((k) => k.startsWith('ANTIGRAVITY_')) || /antigravity/i.test(hint)) return 'antigravity';
  if (env.CURSOR_TRACE_ID || /cursor/i.test(env.TERM_PROGRAM ?? '')) return 'cursor';
  return 'unknown';
}

// --harness, else COORDINATOR_HARNESS, else detect(). A name outside the known ones is kept
// when it is a plain slug (a new tool), and refused otherwise.
export function harnessOf(flag, env = process.env) {
  const raw = typeof flag === 'string' ? flag : env.COORDINATOR_HARNESS;
  if (raw === undefined || raw === '') return detect(env);
  const h = String(raw).trim().toLowerCase();
  if (!SLUG.test(h)) throw new Error(`--harness must be a short name like claude-code, codex, antigravity, gemini (got: ${raw})`);
  return h;
}

export const harnessName = (h) => NAMES[h] ?? h ?? NAMES.unknown;
export const stamp = (harness, skill = VERSION) => ({ harness, skill });

const semver = (s) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? '')); return m ? m.slice(1).map(Number) : null; };
// -1, 0 or 1; null when either is not a version.
export function compare(a, b) {
  const x = semver(a); const y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// The warning a page shows when the run was last written by another version of the skill, or null.
export function versionWarning(skill, mine = VERSION) {
  const c = compare(skill, mine);
  if (c === null || c === 0) return null;
  return c < 0 ? `written by skill ${skill}; this dashboard is ${mine}`
    : `written by skill ${skill}, newer than this dashboard (${mine}): update this copy; parts of the run may not show`;
}

// Where a run came from, for the pages: "started in Antigravity · skill 1.1.0", the last writer
// when it differs, the name the person uses, and the version warning. Runs from before the stamp
// have none: they read "tool and skill version not recorded", without a warning.
export function origin(s, mine = VERSION) {
  const first = s.startedBy ?? null; const last = s.writer ?? first;
  const said = (b) => `${harnessName(b.harness)} · skill ${b.skill ?? 'unknown'}`;
  const line = first ? `started in ${said(first)}` : 'tool and skill version not recorded (an older run)';
  const later = last && first && (last.harness !== first.harness || last.skill !== first.skill) ? `last written in ${said(last)}` : null;
  return { line, later, alias: typeof s.alias === 'string' && s.alias ? s.alias : null, warning: last ? versionWarning(last.skill, mine) : null, harness: last?.harness ?? null, skill: last?.skill ?? null };
}
