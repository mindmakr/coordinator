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

## Evangelists

Telling people about the coordinator helps as much as code. Write up a run you did with it, show it at a meetup or in a stream, or point a team at it. Say what went wrong as well as what worked; honest write-ups bring the bug reports that make it better. If you publish something, open an issue with the link and we may list it.

## Sponsors and partners

If you build a model, a coding tool or an open-source agent, or your team depends on the coordinator, you can help with credits for test runs, an adapter for your harness built together, or sponsorship. Use the [sponsor or partner form](https://github.com/mindmakr/coordinator/issues/new?template=sponsor-or-partner.yml). It opens a public issue, so leave out private contact and payment details; we will agree a private channel there if one is needed. Support is listed openly, and no name is used as an endorsement without its owner's written agreement.

## Reporting a security issue

Don't open a public issue. Use GitHub's private vulnerability reporting on this repository.

## Licence

By contributing you agree that your work is released under the MIT licence of this project, or, for anything under `service/`, under its AGPL-3.0 licence.
