# /coordinator run <task>

## 1. Intake: everything up front

1. Read `COORDINATOR.md`. If it is missing, do `init`'s reading now and put its questions into this run's single batch (step 7); write the file after the answers. Read the task in full: the issue, its comments, linked issues, the PR and its review state.
2. Load lessons: `S/lessons.mjs list --tag <domain> --top 8` (also `--scope project`).
3. Draft the **goal**, the **bar** (`references/bar.md`), the **fence**, the **units** and the **budget** (`references/guardrails.md`, defaults from `S/run.mjs stats`).
4. **Research now, not mid-run.** For anything people will see, collect references: the person's own (Mobbin, screenshots, a design system) first, then web research (`references/craft.md`). For unknowns in the code or the domain, send a researcher. Put what you find into the bar.
5. **Staff the team** from the harness's agents and skills (`references/team.md`).
6. List every question whose answer would change what gets built or what you may do:
   - open product decisions, unclear acceptance, scope edges;
   - every "needs a person" action this run will reach (merge, push, migration, message);
   - whether the run may open issues or PRs upstream for skill improvements (`references/upstream.md`).

   Infer what you can first.
7. **Ask them all in one batch**, with your recommendation first on each. Show the draft goal, bar, fence, references and staffing in the same message so the person can correct them too.
8. Keep every answer: right after `init` (step 2) each one is recorded with `S/run.mjs note <run> --kind decision --text "…"`. Approvals for gated actions are recorded the same way and cover this run only.

From here the run is **unattended**. Do not ask the person anything until the report.

## 2. Set up

`S/run.mjs init <run> --tag <domain> --goal … --bar … --fence "<scope in words>" --paths <dir,dir>`, then `add` each unit (`--after` for stacked work), then `freeze`. Then record the intake answers (step 1.8) on the run. `--paths` is the fence as path prefixes; the detector reads it.

## 3. Loop

Repeat `S/run.mjs next <run>` and act on each unit:

| Action | Do |
|---|---|
| `build` | `start`, then send a builder (`references/briefs.md`) in the background. On its report: `built`. |
| `judge` | Code: run `S/detect.mjs --run <run> --unit <unit> --base <base> --head <the builder's commit>` first (it records which commits it checked, and refuses an empty diff). A hit is a FAIL with that gap, unless the change is legitimate (e.g. an intended snapshot update): then rerun with `--allow <rule>:<path>` and record why with `note --kind decision`. On a run with `--paths`, a PASS is refused without a clean result for this round. Then send a critic. Record with `verdict` (`--score` is required on a fail). |
| `change-strategy` | Pick a different approach, `strategy --text`, then build. |
| `check-stale` | Ask the agent. No answer and `phase: building`: `start` again and send a fresh builder. `phase: judging`: `beat` and send a fresh critic (the build is kept). |
| `wait` | Nothing. A notification will come; never poll. |
| `stop` | Recorded by `next` just now. Its gap goes in the report. |
| `done` / `stopped` | Nothing: the unit passed, or was stopped in an earlier round. |

Briefs for agents outside a git worktree of this repo carry `COORDINATOR_DIR` from `S/run.mjs where`.

The run-level `decision` from `next`:

| Decision | Do |
|---|---|
| `split` | Add units, then `freeze`. |
| `continue` | Act on the units as above. |
| `integrate` | Send the integrator, then `integrate pass|fail`. |
| `done` | Finish (step 4) with outcome `done`. |
| `done-with-gaps` | Integration ran out of budget or hit the same gap twice. Finish with outcome `partial`, listing the gaps. |
| `stopped` | No unit passed. Finish with outcome `stopped`, listing each stop. |

**A question comes up mid-run?** If the recorded decisions answer it, follow them. If not and the step is reversible, take the safest choice that fits the decisions, log it with `note --kind question`, and carry on: it goes in the report for the person to confirm. Stop and ask only for an unapproved gated action.

## 4. Finish

Do the actions approved at intake (for example, merge when the review is READY) and record each one. Then:

- **Report**, at most 12 lines: the outcome, the links, the bar and its evidence, the units stopped and why, the questions you decided on the person's behalf, the follow-ups, and the actions you took.
- **Retro:** `references/learning.md`, then `S/run.mjs close <run> --outcome …`.
