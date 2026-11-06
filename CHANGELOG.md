# Changelog

## 0.3.0 (2026-11-06)

The HUD explains the run in plain words (#7).

- **Situation, Needs you, Time left** at the top of `hud.html` and `run.mjs show`: the lead's latest `note --kind situation` (or a count of tasks in progress, done and waiting), a highlighted box of open questions with the lead's recommendation (`note --kind question --recommend R`, closed by `note --kind decision --answers qN`), and a rough time left from the median try so far and the time budget.
- **One plain sentence per unit**, before the scores: what it is for, how it went, what happens next. `add` takes `--title` and an http(s) `--link`. Raw gap and evidence move behind a toggle.
- **Needs attention** badge on a unit that failed two tries in a row or whose agent went quiet.
- The lead writes a situation note after each verdict and each merge (`references/commands/run.md`).
- All new fields are optional: older state files load and render as before.

## 0.2.0 (2026-11-06)

From the first real run and its owner's feedback.

- **HUD** (#3):
  - `run.mjs show` prints a compact text view: units, phase, rounds, score trend, budget used against its limits (time included), the next step, and counts of questions, follow-ups and decisions;
  - every change rewrites `hud.html` beside the state, in the same lock: one fixed, self-contained template with the unit board, score charts, budget bars, a timeline, and the decisions, questions and follow-ups. No scripts, no network, escaped state text, reloads every 15 s while the run is open, light and dark, phone width;
  - `run.mjs hud <run>` rewrites it on demand and prints its path. `references/hud.md` covers publishing it as an Artifact in Claude Code.
- **Same gap by root cause** (#5): the critic replies with a `CAUSE:` tag, `verdict` and `integrate` take `--cause`, and two rounds with the same cause count as the same gap even when worded differently. Without a cause on both rounds the wording decides, so older state files still load and behave as before.
- **Questions through the question tool** (#2): intake and gated-action questions go through the harness's question tool (AskUserQuestion in Claude Code), each with a short context line and the recommendation first, or a numbered list where there is no such tool. Builders, critics and integrators never ask the person.
- **Short replies** (#1): outcome first, as short as the content allows, with a context line when several pieces of work are active.

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
