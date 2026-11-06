# The HUD: a run at a glance

Two views of the same state, so the person never has to interrupt the loop to ask how it's going. Both read `state.json` and nothing else.

## Text: `S/run.mjs show <run>`

About a dozen lines, for any harness and any terminal:

- **situation:** the lead's latest `note --kind situation`, or, with none, a count such as "3 of 6 tasks in progress, 1 done, 2 waiting";
- **needs you:** each open question (`note --kind question`) with the lead's recommendation (`--recommend`), or "nothing". A `note --kind decision --answers q<N>` closes question N;
- **time left:** rough. The median minutes a try has taken so far, times the tries still ahead on the longest chain of unfinished units (one each, plus the integration check), next to what the time budget has left. No estimate until a try finishes;
- the run, its phase, and when it started;
- the budget used against its limits: time, units, units added after freeze, integration rounds;
- one row per unit: status, round against the round budget, the score trend (`3.5 → 5`), the next action; then one plain sentence (what it is for, how it went, what happens next), marked `!` when it needs attention; then the last gap with its cause;
- the next step for the lead;
- how many questions to confirm, follow-ups and decisions are logged.

`status` replies from it (`commands/status.md`). The full notes are in `workbench.md` beside the state.

## HTML: `hud.html`

`.coordinator/runs/<run>/hud.html` is rewritten after every change, inside the same lock as the state and the workbench. `S/run.mjs hud <run>` rewrites it on demand (for example to update the elapsed time) and prints its path.

- It is one fixed template (`scripts/lib/hud.template.html`) filled from the state, so every run looks the same.
- It opens with the situation, a highlighted **Needs you** box (calm "Nothing needs you" when nothing does) and the rough **time left**, as in the text view.
- Each unit card starts with its plain sentence: what it is for (its `--title`, or the first clause of its bar), how it went ("passed on try 1", "failed twice in a row: <cause>", "building, try 2", "waiting for u1211") and what happens next. Its `--link` is shown when it is an http(s) URL. Then the scores. The raw gap and evidence sit behind a "Gap and evidence" toggle.
- A **needs attention** badge marks a unit that failed two tries in a row or whose agent has gone quiet past `--stale-minutes`.
- **Trade-off:** the toggles close again on each 15-second reload. Keeping them open needs a script, and the page has none by design; open the file without the reload (a closed run, or a published copy) to read at length.
- Below that it shows the unit board with status chips, the score per round as a small chart, budget bars, a timeline of rounds, verdicts and notes, and the decisions, questions and follow-ups.
- It is self-contained: no scripts, no fonts, no network. Its content security policy blocks all three, so it opens from `file://`.
- While the run is open it reloads itself every 15 seconds. It follows the system's light or dark mode and fits a phone screen.
- Every piece of state text in it is escaped. Gaps, evidence and notes quote issues, web pages and agents, so treat them as untrusted.

## Showing it to the person

- **Claude Code:** you may publish `hud.html` as an Artifact (private by default) and give the person the link once. The published copy doesn't follow the file: republish it to the same link at milestones (a verdict, a stop, the finish), not on every change.
- **Other harnesses:** give the person the file's path to open in a browser, or paste `show`'s output.
- State is masked for secrets on a best-effort basis. Read the page before publishing it, and don't publish a run whose notes hold anything the person wouldn't share.
