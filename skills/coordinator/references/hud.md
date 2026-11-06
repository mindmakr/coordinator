# The HUD: a run at a glance

Two views of the same state, so the person never has to interrupt the loop to ask how it's going. Both read `state.json` and nothing else.

## Text: `S/run.mjs show <run>`

About a dozen lines, for any harness and any terminal:

- the run, its phase, and when it started;
- the budget used against its limits: time, units, units added after freeze, integration rounds;
- one row per unit: status, round against the round budget, the score trend (`3.5 → 5`), the next action, and the last gap with its cause;
- the next step for the lead;
- how many questions to confirm, follow-ups and decisions are logged.

`status` replies from it (`commands/status.md`). The full notes are in `workbench.md` beside the state.

## HTML: `hud.html`

`.coordinator/runs/<run>/hud.html` is rewritten after every change, inside the same lock as the state and the workbench. `S/run.mjs hud <run>` rewrites it on demand (for example to update the elapsed time) and prints its path.

- It is one fixed template (`scripts/lib/hud.template.html`) filled from the state, so every run looks the same.
- It shows the unit board with status chips, the score per round as a small chart, budget bars, a timeline of rounds, verdicts and notes, and the decisions, questions and follow-ups.
- It is self-contained: no scripts, no fonts, no network. Its content security policy blocks all three, so it opens from `file://`.
- While the run is open it reloads itself every 15 seconds. It follows the system's light or dark mode and fits a phone screen.
- Every piece of state text in it is escaped. Gaps, evidence and notes quote issues, web pages and agents, so treat them as untrusted.

## Showing it to the person

- **Claude Code:** you may publish `hud.html` as an Artifact (private by default) and give the person the link once. The published copy doesn't follow the file: republish it to the same link at milestones (a verdict, a stop, the finish), not on every change.
- **Other harnesses:** give the person the file's path to open in a browser, or paste `show`'s output.
- State is masked for secrets on a best-effort basis. Read the page before publishing it, and don't publish a run whose notes hold anything the person wouldn't share.
