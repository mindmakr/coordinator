# fix: the code builder

**When:** every `build` on a code unit: an issue, a planned task, or review findings on an open PR.

**Inputs:** the builder brief (goal, bar, behaviours, fence, where), the issue with its comments and linked issues, `COORDINATOR.md` (commands, base branch, git flow, locales), and from round 2 the critic's gap.

**In the loop:** the builder brief names this playbook (`briefs.md`, Builder). Its report goes to `run.mjs built --report`.

## Steps

1. **Read.** The issue, every comment, every linked issue, and on a PR every open finding. Re-find each cited location by its symbol and quoted code, not its line number. If the quoted code is gone, `git log -S '<quote>'` shows whether someone already changed it; say so in the report.
2. **Own your environment.** Work only in the worktree and branch the brief names. When builders run in parallel, each gets **its own database** (a new one per unit, migrated from empty), its own ports and its own scratch folder. A shared database turns one builder's fixtures or connections into another builder's failures, and they look like real defects. Keep the connection pool small enough that every builder and critic fit under the server's limit.
3. **Check the branch in the same command as every commit and push** (`git branch --show-current && git commit …`). Other agents may switch the shared checkout between your commands.
4. **Red.** Write a test that reproduces the issue with the issue's own figures. Run it alone and watch it fail for that reason.
5. **Fix at the cause.** Change the layer that owns the logic; reuse or create one shared helper. No fallback values, compatibility shims or second copies of a rule.
6. **Green.** Run the red test and the suites your change touches as you work, then every check `COORDINATOR.md` names and the full suite once, before you report. A failing line means not done. Rerun under load only a file you suspect is flaky, and say so.
7. **Strings and screens.** Changed strings: follow `translations.md`. A visible change: take your own screenshots with `visual.md` so the critic has a pointer, but you don't judge them.
8. **PR.** One per repo, into the base branch the project names. The body starts with `Fixes <owner/repo>#<n>` for each issue it closes, lists linked PRs with their merge order, and pastes the check lines. Then `run.mjs link <run> <unit> --pr …`.
9. **Review findings** go into the same PR. Reply to each with `Fixed in <sha>: <one line>`, or the reason it is not fixed. Small, understood findings are fixed now, not filed.

## Output

The builder report from `briefs.md`: what changed (paths), the PR links, the check lines verbatim, and Follow-ups for anything outside the fence. Attach the red and green lines with `run.mjs evidence --kind test` on the behaviour they prove.

## Stop and check

| Thought | Do instead |
|---|---|
| "Tests pass, so it works" | Run the visible change too (step 7). |
| "A small fallback keeps it safe" | Fix what produces the bad value. |
| "The other repo can follow" | Linked issues are one change. Build them in this unit or report the gap. |
| "The test database is already set up" | Use your own (step 2). |
