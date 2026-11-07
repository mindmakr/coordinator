# release notes: one change list, several readers

**When:** the integrator's last step on a run that merged work, before a promotion between environments, or when the person asks for a changelog.

**Inputs:** a range (since the last tag, the last promotion, or the run's merges), the repos `COORDINATOR.md` lists, and its environments and audiences.

**In the loop:** the integrator brief names it as the last step when the run merged work; on request, the lead sends it as its own agent.

## Steps

1. **Resolve the range** to a from-ref and a to-ref in each repo. If the brief gives none, use the run's merged PRs.
2. **Collect** merged PRs and first-parent merges in the range. When a title does not say what changed, read the body and the diff. Every line you write traces to a PR or a commit.
3. **Group** into Added, Fixed, Changed, Security, Breaking. A web PR and a mobile PR for the same change are one entry linking both.
4. **For testers:** each user-visible change with its screen and role, the locales and sizes it affects, steps, and the expected result using the issue's figures. Then the areas around it to re-check.
5. **For operators:** from the diffs, new or changed environment variables, migrations, one-off scripts, new jobs or services, runtime upgrades, and the deploy order across repos. Each with what to do, where, and how to roll back. Write "None" for an empty section; never drop it.
6. **For users and stakeholders:** user-visible changes only, in the product's terms, with no PR numbers, file names or implementation status. Say plainly what is not live yet.
7. **Draft, don't publish.** Write the notes to a file, or a draft release when the run allows it. Publishing is a gated action.

## Format

```
## <tag or range> · <date>
Pairs with <other repo> <tag>. Deploy order: <…>.
### Changes
#### Fixed
- <what changed, one line> (#123, owner/repo#45)
### For testers
| Change | Where | Steps | Expected | Locales / sizes |
### For operators
| Item | Action | Environments | Rollback |
```

## Output

Start from `S/run.mjs report <run> --draft` (PRs, merges, migrations, env vars, scripts and jobs read from the run and git) and confirm each line. Store the notes in the run with `S/run.mjs report <run> --file <notes.md>`: they show on the run's report page for devops and testers (`quality.md`).

The integrator reply from `briefs.md`, with the notes' path in EVIDENCE and any PR you could not classify in GAP or OUT-OF-FENCE. Writing follows `craft.md`.
