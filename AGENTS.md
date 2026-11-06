# Working on this repository

- The skill is `skills/coordinator/`. `SKILL.md` stays under 500 words: it routes to `references/` and holds only the rules every command shares.
- Keep it generic. Project facts belong in each project's `COORDINATOR.md`, never in the skill.
- A rule lives in one file. Other files link to it rather than repeat it.
- `retro` is the one command whose playbook is `references/learning.md` (it is also read at intake). A new playbook goes in `references/commands/<name>.md`, plus a row in the SKILL.md table and a `commands/<name>.md` wrapper for the plugin slash command, or `references/domains/<kind>.md`, or a sub-skill: `references/sub-skills/<name>.md` plus a row in `references/sub-skills.md` and a thin `skills/<name>/SKILL.md` that points at it, so the plugin lists it. It reuses the scripts and does not fork them.
- Scripts: Node 18+, no dependencies, one job per file. Logic lives in `scripts/lib/` as pure functions with tests in `scripts/test/`. The CLIs only parse arguments, call `lib`, and print JSON.
- Every write goes through `lib/store.mjs` (atomic, locked, ids validated). No shell strings: use `execFileSync` with argument arrays.
- Nothing stores secrets or personal data, and nothing calls the network, except `run.mjs push` and `pull`, which run git against the project's own remotes when the lead asks, at pit stops; `push` also calls `gh repo view` to learn whether the repo is public when `.coordinator/coordinator.json` does not say.
- Before pushing, run `npm test` and `claude plugin validate .`
- The hosted service is `service/` (AGPL-3.0, its own `package.json` and dependencies, tests with `cd service && npm test`). It imports the skill's `scripts/lib` through `service/src/core.mjs`; the skill never imports the service, and stays dependency-free.
