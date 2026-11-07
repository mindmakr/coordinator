# /coordinator run <task>

## 1. Intake: everything up front

1. Read `COORDINATOR.md`. If it is missing, do `init`'s reading now and put its questions into this run's single batch (step 7); write the file after the answers. Read the task in full: the issue, its comments, linked issues, the PR and its review state.
2. Load lessons: `S/lessons.mjs list --tag <domain> --top 8` (also `--scope project`).
3. Draft the **goal**, the **bar** (`references/bar.md`), the **fence**, the **units** and the **budget** (`references/guardrails.md`, defaults from `S/run.mjs stats`). For work across several repos or issues, follow `references/sub-skills/plan.md`.
4. **Research now, not mid-run.** For anything people will see, collect references: the person's own (Mobbin, screenshots, a design system) first, then web research (`references/craft.md`). For unknowns in the code or the domain, send a researcher with `references/sub-skills/investigate.md`. Put what you find into the bar.
5. **Staff the team** from the harness's agents and skills (`references/team.md`), and pick each role's playbook (`references/sub-skills.md`).
6. List every question whose answer would change what gets built or what you may do:
   - open product decisions, unclear acceptance, scope edges;
   - every "needs a person" action this run will reach (merge, push, migration, message);
   - whether the run may open issues or PRs upstream for skill improvements (`references/upstream.md`).

   Infer what you can first.
7. **Ask them all in one batch, through the harness's question tool** (AskUserQuestion in Claude Code), never as prose in the reply:
   - each question opens with a tiny context line, so it can be answered cold: `<run> · <what it decides>`;
   - your recommended option comes first, marked as recommended;
   - put the draft goal, bar, fence, references and staffing in the reply just before the call, and make "Is this draft right?" one of the questions;
   - the tool takes a few questions per call (four in Claude Code): send the rest in the next call, straight away.

   With no question tool, send one numbered list: each question with its options, the recommended one first. Only you ask. Builders, critics and integrators report questions and blockers to you.
8. Keep every answer: right after `init` (step 2) each one is recorded with `S/run.mjs note <run> --kind decision --text "…"`. Approvals for gated actions are recorded the same way and cover this run only.

From here the run is **unattended**. Do not ask the person anything until the report.

## 2. Set up

`S/run.mjs init <run> --tag <domain> --goal … --bar … --fence "<scope in words>" --paths <dir,dir> [--repo owner/name] [--theme <design-system.css>]`, then `add` each unit (`--after` for stacked work; `--title "#1206 Security gaps"`, `--issue owner/repo#1206` and later `--pr`, repeatable for linked repos, so the dashboard names and links it; one `--behaviour "Given … when … then …"` per behaviour of its bar, `references/bar.md`), then `freeze`. Give the goal its own behaviours with `behave <run> --goal --text …`. Then record the intake answers (step 1.8) on the run. `--paths` is the fence as path prefixes; the detector reads it. Every change also rewrites the run's snapshot, `hud.html` (`references/hud.md`).

**Hear the person at once.** Start two background commands and keep them running until the finish:

- `S/run.mjs watch <run> [--remote]`: one line per new or changed answer and per note from the person. Run it where its lines wake you (a Monitor in Claude Code; elsewhere a background command whose output you check after each agent report). On a line: read it with `S/run.mjs questions <run>` or `show`, act on it, then `S/run.mjs use-answer <run> qN`. A note from the person is their word on the run: follow it inside the fence and the approvals, log scope changes as usual.
  When the run's state is pushed (`push`), add `--remote`: it also pulls the run every 30 s (`--every 10-60`), so answers and notes made on the web HUD or by comment commands arrive within a minute, and within seconds when the coordinator service's doorbell is set (`COORDINATOR_SERVICE`, or `"service"` in `.coordinator/coordinator.json`; it uses your `gh` login). Lines starting `remote:` report the link (doorbell on, pull failed), not answers: no action unless pulls keep failing.
- `S/run.mjs serve <run>`: the live dashboard on 127.0.0.1, with answer forms and a page per unit. Give the person the URL it prints, once. It holds a token: don't paste it anywhere else (`references/guardrails.md`).

## 3. Loop

Repeat `S/run.mjs next <run>` and act on each unit:

| Action | Do |
|---|---|
| `build` | `start`, then send a builder (`references/briefs.md`, playbook `sub-skills/fix.md`) in the background. On its report: `built --report "<its summary>"`; once its PR is open, `link <run> <unit> --pr …`. |
| `judge` | Code: run `S/detect.mjs --run <run> --unit <unit> --base <base> --head <the builder's commit>` first (it records which commits it checked, and refuses an empty diff). A hit is a FAIL with that gap, unless the change is legitimate (e.g. an intended snapshot update): then rerun with `--allow <rule>:<path>` and record why with `note --kind decision`. On a run with `--paths`, a PASS is refused without a clean result for this round. Then send a critic (playbook `sub-skills/review.md`, at full depth; also `visual.md` for screens and a specialist critic for risk areas, all of which must pass). Record with `verdict`, copying the critic's `SCORE`, `GAP` and `CAUSE` into `--score`, `--gap` and `--cause` (score and gap are required on a fail) and each BEHAVIOURS line into `--behaviour B1=pass:"…"`; a pass is refused while a behaviour is failing or unchecked. Add `--critic "<setup>"` (who judged, at what depth) so `stats` can compare escape rates per setup. A specialist critic's reply goes in first with `--specialist <name>`; the pass is refused until every specialist the unit was added with has passed this build. |
| `change-strategy` | Pick a different approach, `strategy --text`, then build. |
| `check-stale` | Ask the agent. No answer and `phase: building`: `start` again and send a fresh builder. `phase: judging`: `beat` and send a fresh critic (the build is kept). |
| `wait` | Nothing. A notification will come; never poll. With `waiting for specialist marks: …`, record each specialist's verdict on the failed round first; only when one cannot come, `start <run> <unit> --force-start --reason "…"` (recorded: its findings on that round are lost). |
| any, with `sync` | Another unit that changes the same files merged first. Merge the target into this unit's branch before the review (or before merging, on a passed unit), check the shared files, then `sync <run> <unit>` (`references/briefs.md`, Hot spots). |
| `stop` | Recorded by `next` just now. Its gap goes in the report. A reason "no progress: only B2 kept failing …" means the rest passed: narrow B2 to a closed list or move it to a unit of its own (`references/bar.md`). |
| `fold-in` | The pass carries fold-ins (`verdict pass --fold`). Have the builder fold them in on top of the reviewed head, run `S/detect.mjs --run <run> --unit <unit> --base <reviewed head> --head <fold head>`, check only those lines and the tests they touch (you, or a light check, never a new critic round), then `foldin <run> <unit> --head <sha> --evidence "…"`. It refuses a head off the reviewed history, a fold over the size caps, or one detect flagged: those need a new round. |
| `ask-person` | **Finish line:** every other unit is decided and this one failed from round 2 on (or at 8 or more) with medium findings at most, from every critic. Run the `step` it gives (`ask <run> --finish <unit>`) and ask the same question through the question tool at once. Record their pick with `answer <run> qN --choice "<label>" --by person --confirm "<their words>"` (or they answer on the dashboard); words that refuse or hedge ("no, do not ship") do not count. `next` then ships it (shown as "Shipped with follow-ups (score N)", every open finding a follow-up in Gaps), records one more round like `extend` (the same-gap and no-progress rules still apply), or stops it. |
| `done` / `stopped` | Nothing: the unit passed, or was stopped in an earlier round. With `step: merge`, its fold-ins are checked and it can merge. |

**After each verdict and each merge**, move the board if the project has one (`references/sub-skills/board.md`) and write the situation in one or two plain sentences: `S/run.mjs note <run> --kind situation --text "Security gaps: failed twice on the same route gate; a new approach is next. Roles: being checked."` It heads the HUD. Say what is happening and what comes next, in the person's words, not unit ids alone.

**A unit the rules stopped.** Two ways on, both the person's call:
- **More rounds in this run** (a round-budget stop only), only on the person's explicit yes (`lib/approval.mjs`). Ask with an approving option: `S/run.mjs ask <run> --unit <unit> --question "One more round for <unit>?" --header <unit> --option "Yes|one more round" --option "No|leave it stopped" --approves Yes`. The question must name the unit (`--unit`). Once they pick Yes, `S/run.mjs extend <run> <unit> --reason "…" --answer qN`. One approval is good for one `extend`, given after the unit's last verdict; it gives one round unless their own words or the option name more (`--rounds 2` needs "two more"), and the decision says which. Without `--answer`, their latest note on the unit since its last verdict must say "approve" or "approved" with no no, not, but, if, maybe or question. "No", free text, a hedge or a lead's own answer is refused. The decision note quotes what they approved. Units stopped as blocked by it stay stopped.
  - **The lead may** use an answer or note the person gave on the dashboard (`serve`) or the web (service, comment commands; it arrives by `pull`), or type their words on the CLI when they gave them in the conversation: `answer <run> qN --choice Yes --by person --confirm "<their words, verbatim>"`, `note <run> --kind person --unit <unit> --text "<their words>" --confirm`.
  - **The lead may not** use `--confirm` without the person's own words, paraphrase them into a yes, answer or note for them otherwise (a plain `answer` or `note --kind person` from the CLI never approves), or approve an extension itself. Editing state.json never approves: an answer, note or question last written by a hand edit (`state.edited` in the log) is refused. This guards against mistakes and casual edits, not a determined lead: a forged events.jsonl line cannot be fully prevented on this machine, because the lead holds the files and the dashboard's token too. An approval that matters is best given on the web (the service writes it with the person's own GitHub login) and checked there.
- **A follow-on run:** `S/run.mjs init <new-run> … --continues <run>:<unit>` and add the unit under the same id, or under a new id with `add <new-run> <new-id> --continues <run>:<unit>`. Both runs record the link; the dashboard, unit page, maps and coordinator page show the chain with both ids, and `stats` counts it as one unit (rounds added up, outcome from the last run; a chain whose last unit was left open in a closed run counts as unfinished, neither passed nor stopped). A unit is continued once: a second follow-on of the same unit is refused, so continue the latest link instead. For a follow-on run made without the flag: `S/run.mjs link <new-run> <unit> --continues <run>:<unit>`.

**Status in the chat.** The person plans their next runs around this one, so say where it stands without being asked. Post `S/run.mjs status-line <run>` as one line, unchanged:
- at each milestone: a unit built, judged or merged, a question asked;
- at least every 30–45 minutes while agents run, even when nothing changed.

It reads "payday-x · Running: 2 of 4 units done (50%), building u3 round 2, about 1 h left (~21:40). Nothing needs you." When the run concludes (after `close`), post its closing line the same way: "payday-x concluded: done. Delivered: … Follow-ups: N in Gaps. Ready for the next run." (`references/hud.md`, Status word).

**Pit stops.** After a unit merges, a decision is recorded, or the run closes (after `close`), run `S/run.mjs push <run>` so the run is in the repo for another machine (`references/durability.md`). Never after every step.

Briefs for agents outside a git worktree of this repo carry `COORDINATOR_DIR` from `S/run.mjs where`.

The run-level `decision` from `next`:

| Decision | Do |
|---|---|
| `split` | Add units, then `freeze`. |
| `continue` | Act on the units as above. |
| `integrate` | Send the integrator (it ends with `sub-skills/release-notes.md` when work merged), then `integrate pass|fail` (with `--gap` and `--cause` on a fail). |
| `done` | Finish (step 4) with outcome `done`. |
| `done-with-gaps` | Integration ran out of budget or hit the same gap twice. Finish with outcome `partial`, listing the gaps. |
| `stopped` | No unit passed. Finish with outcome `stopped`, listing each stop. |

**A question comes up mid-run?** If the recorded decisions answer it, follow them. If not and the step is reversible, take the safest choice that fits the decisions, log it with `S/run.mjs ask <run> --question "…" --header "<≤12 chars>" --option "<your choice>|<why>" --option "<other>|<what it means>" [--unit U]` (2–4 options, your choice first), and carry on: it shows in the HUD's Needs you box with its options and goes in the report for the person to confirm. Stop and ask only for an unapproved gated action, through the question tool as in step 1.7.

**Every question goes to both places.** Ask it through the question tool and mirror it with `S/run.mjs ask` (same options, same order), so the person can answer in the chat or on the answer page. Record the tool's answer with `S/run.mjs answer <run> qN --choice "<label>"` (or `--other "<their words>"`). Whichever answer comes first wins; a later change, from either place, is honoured until you run `use-answer`. Act on the latest answer, then `use-answer`, so it can no longer change under you.

## 4. Finish

Do the actions approved at intake (for example, merge when the review is READY) and record each one (a merge also with `link <run> <unit> --merge <PR URL>`, then a critic with `references/sub-skills/verify.md` on the merged code). Skip that re-check when the merged tree is the reviewed head merged with the target: `git merge-tree --write-tree <target before the merge> <reviewed head>` prints the same tree id as `git rev-parse <merge commit>^{tree}`. Record it with `link <run> <unit> --merge <PR URL> --same-tree <tree id>`.

**Record what each launch cost** as the harness reports it when the agent finishes: `--tokens-in N --tokens-out N --minutes M --cost "0.42 USD"` on `built` (the builder), `verdict` (the critic) and `foldin`. `show`, the dashboard and `stats` sum them per unit, model and run, and say "not recorded" where nothing was. Act on any answer still waiting (`questions`), then stop `watch` and `serve`. Then:

- **Report**, as short as the content allows and at most 12 lines (replies follow `references/craft.md`): the outcome, the links, the bar and its evidence, the units stopped and why, the questions you decided on the person's behalf, the follow-ups, and the actions you took.
- **Release notes:** Release notes never carry credentials, tokens or one-time codes. Name the setting (e.g. API_TOKEN), never its value. When work merged, `S/run.mjs report <run> --draft`, write the notes with `references/sub-skills/release-notes.md`, then `S/run.mjs report <run> --file <notes.md>`; run `S/run.mjs quality <run>` so the report carries the quality and compliance signals (`references/quality.md`). Link the report page in the reply.
- **Retro:** once every unit is decided the dashboard shows **Retro pending**. Ask the person, through the question tool, to run `/coordinator:retro <run>` to conclude the run (recommended first; "close without a retro" second). Then `references/learning.md`, then `S/run.mjs close <run> --outcome …`, which warns while no retro note exists.
