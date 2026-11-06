# Learning from runs

The skill improves in two ways: the lessons it carries into the next run, and the budgets it sets from past runs. Neither one rewrites the skill on its own; a person approves any change to these files.

## The retro, at the end of every run

1. **Repeated gaps.** For each gap the critic raised in two or more rounds, write one lesson: what went wrong, and what fixed it.

   `S/lessons.mjs add --tag <domain> --text "<one sentence, at most 300 characters>" --from <run>`

   Good: "Seed data must use the simulated clock; tests built on the real date failed once time travel moved." Bad: "Be careful with dates."
2. **Stopped units.** For each one, write the reason and what would have unblocked it.
3. **Bar problems.** If a bar was gamed, vague or changed mid-run, write how to state it next time.
4. **The skill itself.** If the run exposed a gap in this skill, not in the project, send it upstream (`upstream.md`).
5. **Staffing.** If a choice of agent clearly helped or hurt, add it as a lesson (`team.md`).
6. **Close the run** with `S/run.mjs close <run> --outcome done|partial|stopped`. Its rounds, time and outcome feed `stats`.

A lesson that was added before only has its count raised, never duplicated. Lessons are stored in `~/.coordinator/lessons.json` with `--scope global` (the default), or in the project's `.coordinator/` with `--scope project`. Project facts belong in project scope.

## Using lessons

- At framing, the lead loads `lessons.mjs list --tag <domain> --top 8` and quotes the relevant ones into the briefs as hints.
- Run `lessons.mjs use <id>` for each lesson the lead used, so the ranking learns which lessons matter.
- `lessons.mjs prune --keep 60` runs during the retro and drops the least-seen, least-used lessons. The file stays small and the loading stays cheap.

## Promoting a lesson

When `lessons.mjs list` shows a lesson that has been seen 3 or more times, propose moving it into the relevant reference file (`bar.md`, `briefs.md`, a domain file or a sub-skill) as a change for a person to review. Once it's merged, `lessons.mjs drop <id>`. That keeps the skill itself short and the lesson store for new things.

## Tuning budgets

`S/run.mjs stats [--tag <domain>]` prints, from the closed runs, the median and 80th-percentile rounds-to-pass per unit, the share of units stopped, and escapes: defects found after a unit passed (`note --kind escape`), per run and overall, with the escape rate (escapes per passed unit). A rising escape rate means the critics need more depth or a specialist, never fewer passes (`sub-skills/review.md`). Set `--max-rounds` to the 80th percentile plus 1, and never higher than 8. If more than 20% of units stop, the bars or the splits are the problem, not the budget: write that down as a lesson.
