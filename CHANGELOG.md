# Changelog

## 0.1.0 (2026-11-06)

First public version.

- Commands: `init`, `run`, `status`, `retro`.
- One intake batch, then an unattended loop: builders, blind critics, an integrator.
- Stop rules in code:
  - round and time budgets;
  - no progress;
  - the same gap after a change of strategy;
  - a blocked stacked unit;
  - a cap on scope added after the split;
  - out-of-order steps refused.
- `detect.mjs`: flags focused, skipped, deleted or renamed-away tests, removed or trivialised assertions, rewritten snapshots, suppressed checks, ignored failures, and edits outside the fence.
- Durable state:
  - atomic and locked;
  - shared across git worktrees;
  - heartbeats for builders and critics;
  - resume after a crash or compaction.
- Lessons: merged, ranked and pruned. Budgets tuned from past runs. Improvements contributed upstream with the user's approval.
- Craft bar (no slop). UI built from researched or supplied references. Roles staffed from the harness's own agents.
