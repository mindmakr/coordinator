# Coordinator context

Facts for Coordinator runs in this repo (the Coordinator skill itself), each with its source. No secrets.

## Work flow
- Base branch `main`; work goes on a feature branch and reaches `main` through one pull request (owner, 2026-11-14; CONTRIBUTING.md, "Pull requests").
- One change per pull request, with a test that fails without it; paste the checks' output into the PR (CONTRIBUTING.md).
- No GitHub Actions workflow runs here; the checks are local. Do not add one without asking (owner's rule on Actions minutes).

## Checks
- Tests: `npm test` (node --test over the list in package.json; a new test file is added to that list). No dependencies to install (owner, 2026-11-14; AGENTS.md).
- Plugin: `claude plugin validate .` from the root (owner, 2026-11-14; AGENTS.md).
- Mapped tests: each script's logic in `skills/coordinator/scripts/lib/<name>.mjs` has `skills/coordinator/scripts/test/<name>.test.mjs`; builders and critics run those files with `node --import ./skills/coordinator/scripts/test/home.setup.mjs --test <files>`.
- Full suite, once per head: `npm test` and `claude plugin validate .`. The service has its own: `cd service && npm test` (only when `service/` changes).
- Nothing needs a database or a service.

## Risk areas
- `SKILL.md` stays under 500 words; a rule lives in one file; skill wording stays generic, project facts go in a project's `COORDINATOR.md` (AGENTS.md).
- Scripts: Node 18+, no dependencies, logic in `scripts/lib/` with tests, no shell strings, every write through `lib/store.mjs`, no network beyond what AGENTS.md lists, nothing stores secrets or personal data (AGENTS.md).
- No new Lucid Coding wording without the owner seeing it (owner, 2026-11-14).

## Review
- Coordinator's review playbook at full depth. Ready means: every behaviour passes with evidence and the full suite passes on the head.

## Standing rules
- None: merging into `main`, tagging and releasing are approved per run.

## Never
- Push to `main` directly; changes reach it through a pull request (CONTRIBUTING.md).
- Add or re-enable a GitHub Actions workflow without asking.

## Isolation
- Each builder works in its own git worktree beside the main checkout, on its own branch from `origin/main`. The scripts need no install and no ports.

## Setup (owner's answers, 2026-11-14)
- Run state: local only (`state: local`).
- Budgets per unit: 4 rounds, 240 minutes.
- Dashboard theme: the built-in one (no theme file).
- Hosted app: not connected.
- Helper models: none.
