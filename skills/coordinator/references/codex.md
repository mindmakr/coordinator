# Using the skill in OpenAI Codex CLI

Codex CLI is the second harness for 1.0. Antigravity, Gemini CLI and the rules for several tools on one project are in `harnesses.md`. The skill and its sub-skills are plain `SKILL.md` folders with no Claude-only syntax in their steps, so Codex loads them as they are. This page is the adapter: install, what differs, and what has been checked.

## Install

Copy every folder under `skills/` into the project's `.agents/skills/` (or `~/.agents/skills/` for all projects). Keep them side by side: each sub-skill reaches its playbook through `../coordinator/references/sub-skills/`. Then add the block below to the project's `AGENTS.md`.

If the project's test command is a bare `node --test`, it also finds the skill's own tests under `.agents/skills/`. Delete `.agents/skills/coordinator/scripts/test` after copying, or name the project's test files in the command.

## What differs

| In Claude Code | In Codex |
|---|---|
| `/coordinator:run`, `/coordinator:review` and the other plugin commands | No slash commands for skills: name the skill in the request ("use the coordinator skill to run …", "use the review skill on PR 12") |
| The Agent tool starts builders and critics | Codex starts sub-agents when `AGENTS.md` or a skill asks for them (the block below asks). Without them, start each builder and critic as its own `codex exec` with the brief from `run.mjs brief`: a fresh process is as blind as a fresh agent |
| The question tool (AskUserQuestion) at intake | No question tool. Interactive: the numbered list in `commands/run.md` step 1.7. Headless (`codex exec`): nobody can answer, so put the answers in the prompt, or park each question with `run.mjs ask` and answer it on the dashboard (`run.mjs serve`) |
| A Monitor wakes the lead on `watch` lines | Run `watch` as a background command and read its output after each agent report |
| `${CLAUDE_SKILL_DIR}` is expanded | It is not: read it as the folder holding that `SKILL.md`, whose path Codex shows in its skill list |
| The `code-review` and `security-review` skills (`sub-skills/review.md` steps 3–4) | `codex review --base <branch>` for the correctness pass; for security, the project's scanners plus the reading list in step 4. Depth stays fixed either way |
| Artifacts for the dashboard | The file path of `hud.html`, or the `serve` URL |

## AGENTS.md block

Add this to the project's `AGENTS.md`:

```
## Coordinator
- For multi-step work that must reach a bar, use the `coordinator` skill in `.agents/skills/coordinator`.
- It may start sub-agents: one builder per unit and a separate critic per round. Delegate when it says to.
- Each brief names a playbook in `.agents/skills/coordinator/references/sub-skills/`. Follow it.
- Project facts live in `COORDINATOR.md`, not in the skill.
```

## What has been checked

On `codex-cli 0.160.0`:

- **Discovery:** with the folders in `.agents/skills/`, Codex lists all ten skills with their descriptions (`codex debug prompt-input`).
- **A headless run** (`tools/codex-e2e.mjs`, Windows, 2026-11-07): Codex read the skill and `run.md`, kept the run through `run.mjs` (init, a unit with a behaviour, freeze, start, built, detect, notes, a beat), served the dashboard, and started two reviewers as sub-agents. The fix was right and the test passed. It did not reach a verdict: the project's bare `node --test` also ran the skill's own tests (hence the install note above, now fixed in the check), and then the account hit its usage limit.
- Seen on that run: the lead recorded `start` and `built` together after the builder finished, instead of `start` before it; and the workspace-write sandbox on Windows could not run a Node installed through nvm's symlink, so Codex searched for another one.

**Not checked yet:** a run that closes `done` end to end. A re-run at 01:47 local time on 2026-11-07, with `--sandbox danger-full-access`, stopped at once on the same usage limit (reset 05:29). Run `node tools/codex-e2e.mjs --dir <empty folder>` from this repository; it prints each check as JSON.
