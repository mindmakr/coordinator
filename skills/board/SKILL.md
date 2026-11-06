---
name: board
description: Use when keeping a project board in step with a coordinator run (freeze, verdicts, merges) or giving a standup summary from the run and the board.
---

# board

A built-in sub-skill of the coordinator. Read and follow `${CLAUDE_SKILL_DIR}/../coordinator/references/sub-skills/board.md`, and the shared rules in `${CLAUDE_SKILL_DIR}/../coordinator/references/sub-skills.md`. Outside Claude Code, `${CLAUDE_SKILL_DIR}` is this skill's folder.

In a coordinator run, the brief says what to do and how to reply. Run on its own, take the project's facts from its `COORDINATOR.md` (or its own docs, citing them), and reply to the person in the playbook's Output shape.
