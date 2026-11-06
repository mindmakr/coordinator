# review: the code critic, with a security pass

**When:** every `judge` on a code unit. A second copy, with the specialist section, for units in a risk area.

**Inputs:** the PR (or branch) head commit, the base branch, the unit's bar and behaviours, the acceptance list, the risk areas and rules in `COORDINATOR.md`, the `detect.mjs` result, and from round 2 the earlier CAUSE tags.

**In the loop:** the critic brief names this playbook for code units (`briefs.md`, Critic), after the lead has run `detect.mjs`. Its reply goes to `run.mjs verdict`.

## Depth is fixed

Cheaper review rounds have passed work that still had real bugs, and the fix cost more later. So every round runs at full depth, whatever the budget:

- a strong model, never the cheap tier the builders may use;
- the whole diff at the new head, plus the files that call what changed;
- the red test against the base, and the full checks against the head;
- the correctness, security and project-rule passes below, every round.

A budget may cut rounds or minutes. It never cuts a pass, the diff's reach or the model tier.

## Steps

1. **Check out the head** in your own worktree, never the builder's working copy. If the checks need a database, use your own, migrated from empty or from the project's fixture, not the builder's.
2. **Red, then green.** Run the unit's red test on the base: it must fail for the reason the issue gives. Run it on the head: it must pass. Then run every check `COORDINATOR.md` names on the head, and paste the pass or fail lines.
3. **Correctness pass.** Run the harness's own code-review tool on the diff at its thorough level (in Claude Code, the `code-review` skill at `high`; use `max` or `ultra` only if the person asked). Where there is none, read the diff line by line for wrong results, missed callers, broken error paths and race conditions.
4. **Security pass.** Run the harness's security tools: a security-review skill or a security reviewer agent, and any secret, dependency or static scanner the project has, on what the PR adds. Then read the diff for:
   - authorisation on every new route and action, and tenant or owner scoping on every query;
   - injection and unsafe input handling;
   - **oracles:** a response, label, count or row that tells one user something about another (that an account exists, works elsewhere, holds a role);
   - **timing on auth paths:** audit, logging and lookup work on a failure path must run inside the same equal-time envelope as the success path, or after the reply, for every branch. Extra reads after the time floor on one branch reopen an enumeration signal. A timing test must call the real route, not a helper;
   - workflow changes: every job time-limited, a new run cancels the old, triggers only on the branches the project names.

   A confirmed security finding is at least high.
5. **Project-rule pass.** Read the project's rule files (`COORDINATOR.md`, plus `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` where present). Check the diff against each rule that applies, and cite the rule with the finding.
6. **Other reviewers.** Read existing reviews, bot comments and failing checks on the PR. Each claim is a candidate: verify it like your own and credit its author.
7. **Verify every candidate.** Keep it only when you open the file at the head and see the quoted line, and the reason holds. A finding that depends on intent goes to the lead as a question, not a FAIL.
8. **Gaming.** Read the `detect.mjs` result and the test changes yourself: skipped, deleted or loosened tests, rewritten snapshots, a new fallback that hides the bug, edits outside the fence.

## Copy under approval

Wording that goes through the project's own approval is not failed on nuance (`translations.md`, Copy under approval). A claim the code makes untrue (for example "we told your employer" when nothing does) is a note for the approver, not the GAP.

## Specialist critic (risk areas)

For money, auth, migrations, time zones, a simulated clock, or any area `COORDINATOR.md` marks, the lead sends a second critic with this playbook plus the area: a specialist agent where the harness has one (security, database, accessibility). It runs steps 1, 2 and 7 itself and goes deep on the area. Both critics must pass.

## Output

The critic reply from `briefs.md`:

- **GAP** is the single highest finding. High and medium findings fail the unit; lows go in EVIDENCE as notes for the next round.
- **CAUSE** names the root cause in 2–5 words ("audit writes after time floor"), not the symptom ("slow sign-in"). When the cause matches an earlier round's, reuse its tag word for word: that is how the loop spots a stuck unit.
- **EVIDENCE** gives each finding an id, severity, `path:line` at the head commit, the quoted line and the fix.
- If the run's decisions allow review comments on the PR, post the findings as one review per round, as a comment. Never approve, request changes or merge.
