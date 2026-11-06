# Contributing

Thanks for helping make the coordinator better. Most improvements come from real runs: something stopped too late, a rule was unclear, a critic missed a trick. Those reports are the most valuable thing you can send.

## Ways to help

| You have | Do this |
|---|---|
| A run that went wrong | Open an issue: what you asked for, what the coordinator did, what you expected, and the relevant part of `workbench.md` with project details removed |
| A lesson that keeps recurring | Open an issue tagged `lesson`, with the lesson text, how many runs showed it, and the evidence |
| A fix | Open a PR (see below) |
| A new playbook | Open an issue first describing the command or domain, the bar it uses and what the critic checks. Then a PR |

Agents using this skill may open these issues and PRs themselves, but only with their user's approval (see `skills/coordinator/references/upstream.md`).

## Pull requests

1. Keep the change small and about one thing.
2. Follow `AGENTS.md`:
   - SKILL.md stays under 500 words;
   - a rule lives in one file;
   - scripts have no dependencies, keep their logic in `scripts/lib/`, and have tests;
   - no network calls and no secrets.
3. A behaviour change needs a test that fails without it.
4. Run the checks and paste their output into the PR:

   ```
   npm test
   claude plugin validate .
   ```

5. Write in plain, specific language. The writing gets the same craft bar the skill enforces (`references/craft.md`).

## Reporting a security issue

Don't open a public issue. Use GitHub's private vulnerability reporting on this repository.

## Licence

By contributing you agree that your work is released under the MIT licence of this project.
