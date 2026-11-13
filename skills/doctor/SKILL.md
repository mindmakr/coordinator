---
name: doctor
description: Use when checking that the coordinator is set up correctly on this machine and project (Node, gh login and scopes, git remote, COORDINATOR.md, .coordinator/ settings, stale locks or dashboards, worktree links, stored run artifacts), after /coordinator:init, or when a run misbehaves.
---

# doctor

A built-in check of the coordinator's setup. Run it and show the person its output:

```
node ${CLAUDE_SKILL_DIR}/../coordinator/scripts/doctor.mjs
```

Outside Claude Code, `${CLAUDE_SKILL_DIR}` is this skill's folder.

- One line per check: `ok`, `warn`, `FAIL` or `skip`, what it found, and after `→` the one-line fix.
- `--json` prints the same as JSON (`ok`, `checks[]` with `id`, `status`, `text`, `fix`). `--offline` skips the checks that reach GitHub (gh login, the state repo's visibility, the latest release). It exits 1 when any check fails.
- It never prints a token or a password: gh output is parsed, never echoed, and URLs lose their credentials.

Checks: `node` (18+), `version` (plugin against the latest release tag), `gh` (installed, logged in, `repo` and `project` scopes), `git` (repo and remote), `context` (`COORDINATOR.md` present, its commands still in a `package.json`: the folder a command names (`cd backend && …`, `--prefix`, `-C`, `--cwd`, `-w`), else the root, its workspaces and first-level app folders, naming where each was found or the files searched; its `Theme:` file exists), `state-dir` (`.coordinator/` writable and git-ignored), `settings` (`.coordinator/coordinator.json`, every key in `references/commands/init.md`), `state` (where run state goes; a public `stateRepo` fails), `locks`, `dashboards` (a `serve` still holding a port; a record whose process is gone is removed), `artifacts` (stored evidence intact by sha256, with the way to restore it; files a run mentions that need `run.mjs adopt`, or whose path is unclear), `worktrees` (`node_modules` linked into a worktree), `lessons` (readable), `codex` (the install, when `AGENTS.md` has the Coordinator block), `copies` (every installed copy of the skill it finds, in Claude Code's plugin cache, `.agents/skills`, Codex, Gemini CLI and Antigravity folders, with versions; warns when they differ), `harnesses` (Gemini or Antigravity instructions that name the coordinator with no copy of the scripts), `registry` (the runs on this PC with the tool and skill version that last wrote each; `../coordinator/references/harnesses.md`), `prefix` (the fixed prompt prefix: enabled plugins, skills and their description characters, MCP servers, and whether the project has a local trim; warns when it loads many skills with no trim, fixed with `prefix.mjs draft` then `write --confirm`; `../coordinator/references/context.md`, rule 7).

Fix what you safely can only when the person asks; otherwise list the fixes. Never delete a lock, a record or a worktree link while a coordinator command or dashboard may be using it.
