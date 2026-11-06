# Durable runs

A run can outlive a context window, a crash, or the person going away. The state file is the run, and memory is only a cache of it.

## State

- `.coordinator/runs/<run>/state.json` holds the goal, bar, fence, budget, units, rounds, notes and decisions.
- State written by an older version still loads: fields added later (such as a round's `cause`) are optional.
- Every write is atomic: the script writes a temporary file and renames it over the real one, behind a lock file. Two writers cannot corrupt the state; a lock older than 30 s is taken over.
- `.coordinator/runs/<run>/workbench.md` and `hud.html` are rewritten after every change, inside the same lock. People read them from anywhere, so nobody has to interrupt the loop to ask how it's going (`hud.md`).
- Add `.coordinator/` to `.gitignore`. It is working state, not a deliverable.

## Background agents

- Start builders and critics as background agents. The harness notifies the lead when one finishes, so never poll and never sleep-loop.
- Long checks, such as full test suites, builds or visual sweeps, run as background commands that write a log file. The agent reports the log path and the pass or fail line.
- The agent beats with `run.mjs beat <run> <unit>` at each milestone: it pushed, the tests ran, the review finished. The builder and critic briefs carry the exact command. `next` returns `check-stale` for a builder or critic with no beat for `--stale-minutes`.
- **Stale:** first ask the agent for its status. If there's no answer:
  - with `phase: building`, `start` the unit again and send a fresh builder from the last pushed state;
  - with `phase: judging`, the build is kept: `beat` the unit and send a fresh critic.
- **Where the state is:** `.coordinator/` sits beside the main checkout, so builders in git worktrees of the same repo reach it with no setup. An agent working anywhere else (another clone, another machine path) gets `COORDINATOR_DIR=<dir>` in its brief; `S/run.mjs where` prints the value.

## Resume

After compaction, a restart or a new session:

1. Run `S/run.mjs list`, then `S/run.mjs show <run>`.
2. For each in-progress unit, check its branch, worktree or output for the latest real state. A unit with no artifact goes back to build with `S/run.mjs reset <run> <unit> --reason "…"`, so nobody waits out the stale timer.
3. Run `S/run.mjs next <run>` and carry on.

## Isolation

- Code: one worktree and one branch per builder, created from the current base. Install dependencies in each worktree. Never link `node_modules` or other shared folders between worktrees: deleting one can delete the other.
- Databases or services shared with other work: give each builder its own database or port, recorded in the unit's notes.
- Stacked work, where B builds on A: B branches from A's branch, rebases after A merges, and opens its PR only then (`run.mjs add … --after A`).
