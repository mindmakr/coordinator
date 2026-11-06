# plan: units, bars and linked issues

**When:** at intake, when the work spans several repos or issues, or is too big for one builder. The lead runs it, after `investigate.md` has cited the current state. It changes no code.

**Inputs:** the request, the investigation, `COORDINATOR.md` (repos, layers, linked-issue order, risk areas, board), and existing issues and milestones.

**In the loop:** the lead follows it at intake (`commands/run.md` step 1.3); its table becomes the units, the behaviours and the staffing note.

## Steps

1. **Restate the goal** in one or two lines, and write its behaviours (G1, G2, …).
2. **Reuse what exists.** Search open issues, milestones and PRs. A unit can carry an existing issue rather than a new one.
3. **Split into units** (`domains/code.md`, Split):
   - one unit per independently reviewable change, usually one per repo;
   - the layer that owns the logic first, its clients after (`--after`);
   - changes that touch the same files go into one unit;
   - a unit a builder cannot finish in one round's budget is split again.
4. **Give every unit its code and its done-result:** the files or symbols it changes, cited, and its behaviours. A unit without a citation is a guess.
5. **Bound every bar** (`investigate.md`, Bound the bar). A behaviour that needs open-ended language detected is narrowed to a closed set or moved to a person's review before freeze.
6. **Mark risk areas.** A unit touching money, auth, migrations, time zones or an area `COORDINATOR.md` marks gets a specialist critic as well (`review.md`). Write it in the staffing note.
7. **Plan the environment.** Units that run in parallel each get their own worktree and database (`fix.md`). Count the database connections at the planned parallelism.
8. **Linked issues.** When a change spans repos, one issue per repo, each linking the others and saying they ship together, with the merge order. Creating issues is a question for the intake batch.

## Output

A table the lead turns into `run.mjs add` calls: unit, title, repo, issue, after, behaviours, critic setup. Put it in the intake reply with the other drafts, so "Is this draft right?" covers it. After the answers: `add` each unit, `freeze`, and `board.md` puts the cards in step.
