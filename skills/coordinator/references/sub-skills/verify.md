# verify: done means every acceptance item passed on merged code

**When:** after a unit's PR merges, before its issue closes; and before a release, over everything in it.

**Inputs:** the issue's acceptance list, the merged PR and its merge commit, `COORDINATOR.md` (local run, checks, how issues close).

**In the loop:** a critic brief names this playbook after a merge the run made, and the integrator uses it for the goal's behaviours when the run ends in merges.

## Steps

1. **Pin the code.** Merged: check out the merge commit in your own worktree. When the merged tree equals the reviewed head merged with the target, the review stands and the lead skips this check (`commands/run.md`, Finish: `link --same-tree`). Not merged: check the PR head and report; close nothing.
2. **One check per acceptance item:**
   - **test:** a test that asserts the item; paste its pass line;
   - **visual:** `visual.md` on the screens the item names, in the locales and sizes it names;
   - **manual:** steps you run on the local stack; for a shared environment, written steps for a tester.
3. **Run on the local stack** with seeded or fixture data only, your own database, and the full checks once. Never real accounts or credentials.
4. **Record** a table: item, check, pass or fail, evidence. Attach each piece with `run.mjs evidence`.
5. **Conclude.**
   - All pass: the issue may close, if the run's decisions allow closing issues, with a comment naming the PR and merge commit.
   - Any fail: the issue stays open or reopens, if allowed, naming the failing item and its evidence.

## Escapes

A defect found here in a unit that already passed is an **escape**: the review that passed it missed it. Record it so the evidence for review depth builds up: `S/run.mjs note <run> --kind escape --unit <unit> --text "<defect>; found by verify"` (it works on a closed run too, and records the round that passed it). `stats` counts escapes per run and overall, and `show` and the dashboard show them. A defect the change did not cause is a follow-up, not an escape.

## Output

The critic reply from `briefs.md`, with one BEHAVIOURS line per acceptance item. A pass needs every item passed with evidence.
