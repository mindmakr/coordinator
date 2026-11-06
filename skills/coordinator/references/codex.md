# Using the skill in OpenAI Codex CLI

Codex CLI is the second harness the 1.0 design recommends. The skill and its sub-skills are plain `SKILL.md` folders with no Claude-only syntax in their steps, so Codex can load them as they are. This page says what has been checked and what has not.

## What has been checked

On `codex-cli 0.160.0`: with this repository's `skills/*` folders copied into a project's `.agents/skills/`, Codex lists all ten skills (`coordinator` and the nine sub-skills) with their descriptions. Checked with `codex debug prompt-input`, which prints what the model would see without calling it.

**Not checked yet:** a full `run` end to end, sub-agent delegation, the background `watch` and `serve` commands, and the question fallback. Treat Codex as untested until the 1.0 end-to-end run passes.

## Install

Copy every folder under `skills/` into the project's `.agents/skills/` (or `~/.agents/skills/` for all projects). Keep them side by side: each sub-skill reaches its playbook through `../coordinator/references/sub-skills/`.

## Differences to know

| In Claude Code | In Codex |
|---|---|
| `${CLAUDE_SKILL_DIR}` is expanded | It is not: read it as the folder holding that `SKILL.md`, whose path Codex shows in its skill list |
| `/coordinator:review` and the other plugin commands | Name the skill in the request ("use the coordinator skill to run …", "use the review skill on PR 12") |
| The question tool | The numbered-list fallback in `commands/run.md` step 1.7 |
| A Monitor wakes the lead on `watch` lines | Run `watch` as a background command and read its output after each agent report |
| The `code-review` and `security-review` skills (`sub-skills/review.md` steps 3–4) | `codex review --base <branch>` for the correctness pass; for security, the project's scanners plus the reading list in step 4. Depth stays fixed either way |

Codex starts sub-agents only when `AGENTS.md` or a skill explicitly asks for them. The coordinator skill does ask, but saying so in `AGENTS.md` removes the doubt.

## AGENTS.md block

Add this to the project's `AGENTS.md`:

```
## Coordinator
- For multi-step work that must reach a bar, use the `coordinator` skill in `.agents/skills/coordinator`.
- It may start sub-agents: one builder per unit and a separate critic per round. Delegate when it says to.
- Each brief names a playbook in `.agents/skills/coordinator/references/sub-skills/`. Follow it.
- Project facts live in `COORDINATOR.md`, not in the skill.
```
