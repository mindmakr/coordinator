# /coordinator init

Learn the project once, so that every later run starts informed and asks only about the task.

## Steps

1. **Read before asking.** Look at the README, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, any `.agents/` profile, the package scripts, the CI files, the branch list, and the project's own skills. Infer everything you can.
2. **Ask only what is left**, in one batch, each question with your recommended answer first. Typical gaps:
   - Which branch work goes into, and which branches are protected.
   - Whether a run may merge into the working branch when the review passes, or only open the PR.
   - Which checks prove a change: the exact commands, and whether any need a database or service.
   - Risk areas the critic must always check, such as money, auth, migrations, time zones, or a simulated clock.
   - The review skill or reviewer to use, if any.
   - How the person wants to be told: only at the end, or also when a unit stops.
3. **Write `COORDINATOR.md` at the project root** with the headings below. Keep it short, with one line per fact and its source. It is shared with the team, so commit it if they agree. It holds no secrets.

```
# Coordinator context
## Work flow        base branch, protected branches, PR rules
## Checks           commands that prove a change, and what each needs
## Risk areas       what a critic must always check here
## Review           the review skill or reviewer, and what "ready" looks like
## Standing rules   actions pre-approved for every run (e.g. "merge into test when review is READY")
## Never            actions that need a person every time
## Isolation        how builders get their own worktree, database, ports
```

4. Add `.coordinator/` to `.gitignore`.

## Updating it

If a run learns a lasting project fact (a check that was missing, a risk area that bit), propose a one-line change to `COORDINATOR.md` in the retro. The person approves it; the lead never edits it silently.
