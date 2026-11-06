# Code: fixing issues and PRs, building features

## Bar

1. **Red, then green.** Write a test that reproduces the issue with the issue's own figures. The critic sees it fail on the base branch and pass on the fix.
2. **The full checks:** typecheck, lint, the test suite, and whatever the project names. The critic runs them itself or reads the logged output for the exact commit.
3. **The acceptance list** from the issue, plus every decision the owner recorded on it.
4. **A blind review of the diff.** If the project has a review skill, the critic runs it at its thorough level. Otherwise it follows `sub-skills/review.md`: correctness, a security pass and the project's rules, at full depth every round.
5. **Visible changes:** screenshots of the changed screens in each language and at phone width.

## Split

- One unit per independently reviewable change: often one per repo, or server first and then its clients.
- Changes that touch the same files go into one unit.
- Stacked work (B needs A) becomes two units, with B marked `--after A`.

## Builder

- Uses the project's own fix skill or contribution guide if there is one.
- Works in its own worktree and branch, and opens a PR into the base branch the project names. It never merges.
- Addresses review findings in the same PR. Small, understood findings are fixed now, not filed for later.

## Critic

- Checks out the PR head, never the builder's working copy. It runs the red test against the base, then the checks against the head.
- Looks for gaming: skipped or loosened tests, regenerated snapshots, changes outside the fence, new fallbacks that hide the bug.
- Checks the risk areas the project marks: money, auth, migrations, time zones, a simulated clock.
- One finding is the GAP; everything else goes in EVIDENCE as notes for the next round.

## Done

A PR that the critic and the integrator both pass, with the review at READY. Merging happens only when a person says so, or under a standing rule that person gave for this run, recorded with `run.mjs note --kind decision`.
