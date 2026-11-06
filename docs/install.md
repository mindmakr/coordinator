# Install

Coordinator is a skill: Markdown playbooks and Node scripts. It runs in your coding harness, on your machine. Two harnesses are supported in 1.0: Claude Code and OpenAI Codex CLI.

**Needs:** Node 18+ and git. Nothing else is installed.

In every project, add `.coordinator/` to `.gitignore`. That folder holds the run state on your machine.

## Claude Code

As a plugin:

```
/plugin marketplace add mindmakr/coordinator
/plugin install coordinator@coordinator
```

Then, in a project:

```
/coordinator:init
/coordinator:run Fix issue #142 (wrong totals on the dashboard)
```

Without the plugin, copy every folder under `skills/` into `~/.claude/skills/` (all projects) or the project's `.claude/skills/`. Keep them side by side. The commands are then `/coordinator init`, `/coordinator run <task>` and so on.

## OpenAI Codex CLI

Copy every folder under `skills/` into the project's `.agents/skills/` (or `~/.agents/skills/` for all projects). Keep them side by side: each sub-skill reaches its playbook through `../coordinator/`.

```
git clone https://github.com/mindmakr/coordinator /tmp/coordinator
mkdir -p .agents/skills && cp -r /tmp/coordinator/skills/* .agents/skills/
```

Add the block from [the Codex adapter](../skills/coordinator/references/codex.md#agentsmd-block) to the project's `AGENTS.md`, then ask by name:

```
codex "Use the coordinator skill to run: fix issue #142 (wrong totals on the dashboard)"
```

Codex has no slash commands for skills and no question tool. [The adapter](../skills/coordinator/references/codex.md) says what changes.

If the project's tests run with a bare `node --test`, it also finds the skill's own tests under `.agents/skills/`. Delete `.agents/skills/coordinator/scripts/test` after copying, or name your test files in the command. The same goes for a copied skill in Claude Code.

## Check it works

```
node .agents/skills/coordinator/scripts/run.mjs where     # Codex
node ~/.claude/skills/coordinator/scripts/run.mjs where   # Claude Code, copied skill
```

It prints the state folder. Nothing has been written yet.

## Next

- [Connect a repo](connect.md) to follow runs from a phone (optional).
- [Privacy](privacy.md): what stays on your machine.
