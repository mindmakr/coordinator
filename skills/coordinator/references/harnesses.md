# The skill in other tools: Antigravity, Gemini CLI, and several at once

The coordinator is plain `SKILL.md` folders and Node scripts, so any tool that reads skills can run it. Codex has its own page (`codex.md`). This page covers Google Antigravity and Gemini CLI, and the rules that hold whichever tool starts a run.

## The rules for every tool

**Runs go only through `run.mjs`.** A lead in any tool records every step with `node <skill>/scripts/run.mjs …`. It never writes `state.json`, `events.jsonl` or anything else under `.coordinator/` by hand: a hand edit is recorded as `state.edited` and never counts as an approval, and a tool with no copy of the scripts cannot keep a run at all (`/coordinator:doctor` flags it). Leads in several tools may work on the same project and machine at once: each write takes the run's lock, and the run register (`hud.md`) takes its own.

**Say which tool you are.** Each write records the tool that made it. Pass `--harness <name>` on any `run.mjs` command, or set `COORDINATOR_HARNESS` for the session. Without either, the scripts guess from the environment, in this order:

| Tool | Detected by | Name |
|---|---|---|
| Claude Code | `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` | `claude-code` |
| Codex CLI | any `CODEX_*` variable except `CODEX_HOME` | `codex` |
| Gemini CLI | `GEMINI_CLI` | `gemini` |
| Antigravity | an `ANTIGRAVITY_*` variable, or "antigravity" in `TERM_PROGRAM` or the editor's `VSCODE_*` paths | `antigravity` |
| Cursor | `CURSOR_TRACE_ID`, or "cursor" in `TERM_PROGRAM` | `cursor` |
| anything else | | `unknown` |

A tool's own marker wins over the editor it runs in: Gemini CLI in Antigravity's terminal is `gemini`. The guess is best effort; the flag and the variable always win. Any other short lowercase name is kept as given.

**Give the run the name you use.** `run.mjs init <run> --alias "payday-onboarding-filter" …` records what you call it, and the pages show it beside the id, so a run stored as `payday-1275-onboarding` is still found by that name.

**Keep the copies at one version.** Each tool reads its own copy of the skill. A run written by an older or newer copy still loads, with a warning on its pages ("written by skill 1.0.0; this dashboard is 1.1.1"). `/coordinator:doctor` lists every copy it finds, with versions, and warns when they differ.

**See them all.** `/coordinator:dashboard` (`run.mjs dashboard`) shows every run on this PC, from every tool and project; `run.mjs list --all` prints the same.

## Google Antigravity

1. Copy every folder under `skills/` into the workspace's `.agent/skills/` (one project) or `~/.gemini/antigravity/skills/` (every workspace). Keep them side by side: each sub-skill reaches its playbook through `../coordinator/references/sub-skills/`.
2. Add a rule, `.agent/rules/coordinator.md`:

   ```
   - For multi-step work that must reach a bar, use the coordinator skill.
   - Record every step with `node .agent/skills/coordinator/scripts/run.mjs … --harness antigravity`. Never write .coordinator/ files by hand.
   - Project facts live in COORDINATOR.md.
   ```
3. Start each builder and critic as its own agent in the Agent Manager, with the brief from `run.mjs brief`: a fresh agent is as blind as a fresh process. There is no question tool: park questions with `run.mjs ask` and answer them on `run.mjs serve <run>`.

## Gemini CLI

1. Copy every folder under `skills/` into `.gemini/skills/` (one project) or `~/.gemini/skills/`, side by side.
2. Add to the project's `GEMINI.md`:

   ```
   ## Coordinator
   - For multi-step work that must reach a bar, use the coordinator skill.
   - Record every step through its scripts/run.mjs; never write .coordinator/ files by hand.
   ```
   Gemini CLI sets `GEMINI_CLI=1` for the commands it runs, so the tool is detected; `--harness gemini` makes it explicit.
3. Start builders and critics as separate `gemini -p "<brief>"` processes with the brief from `run.mjs brief`. In a non-interactive session, park questions with `run.mjs ask` and answer them on the dashboard.

## Where the doctor looks for copies

Claude Code's plugin cache (`~/.claude/plugins/cache/*/coordinator/<version>/skills`, skipping versions marked orphaned), `~/.claude/skills` and the project's `.claude/skills`; `.agents/skills` (home and project); `.codex/skills`; `.gemini/skills` and `~/.gemini/extensions/*/skills`; `~/.gemini/antigravity/skills` and the project's `.agent/skills`. Instructions it reads: `GEMINI.md` (project and `~/.gemini`), and `.agent/rules`, `.agent/workflows` (or `.agents/…`) for Antigravity.

## What has been checked

Detection, the stamp, the version warning and the register have tests (`registry.test.mjs`). A full run inside Antigravity or Gemini CLI has not been checked end to end. The case behind this page: a run started from Antigravity on a project whose other runs came from Claude Code, stored under an id the person did not know it by.
