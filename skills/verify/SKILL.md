---
name: verify
description: Use when verifying merged work against its acceptance list before an issue closes, item by item with evidence, or when checking release items.
---

# verify

A built-in sub-skill of the coordinator. Read and follow `${CLAUDE_SKILL_DIR}/../coordinator/references/sub-skills/verify.md`, and the shared rules in `${CLAUDE_SKILL_DIR}/../coordinator/references/sub-skills.md`. Outside Claude Code, `${CLAUDE_SKILL_DIR}` is this skill's folder.

In a coordinator run, the brief says what to do and how to reply. Run on its own, take the project's facts from its `COORDINATOR.md` (or its own docs, citing them), and reply to the person in the playbook's Output shape.
