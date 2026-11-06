# board: the project board in step with the run

**When:** the lead, at freeze, after every verdict and every merge; and on request for a standup summary. Only when `COORDINATOR.md` names a board.

**Inputs:** the run state (`run.mjs show <run>`), the board named in `COORDINATOR.md` with its status field and options, and each unit's issues and PRs (`run.mjs link`).

**In the loop:** the lead does this itself, never an agent (`commands/run.md`, after each verdict and merge).

## Moves

| Run event | Card status |
|---|---|
| `freeze` | each unit's issues: Ready (or the board's equivalent) |
| `start` | issues: In progress |
| PR linked | issues and PR: In review |
| unit passed, review ready | PR: Ready to merge |
| unit failed, round continues | unchanged |
| unit stopped | issues back to Ready, with the last gap in a comment if comments are allowed |
| merged | PR: Done; issues: the board's post-merge status |
| verify passed | issues: Done |

Use the board's own option names; map them once at intake and record the map with `run.mjs note --kind decision`.

## Rules

- **Move cards only.** Set status and the fields the board already has. Never create, rename or restructure a board, field or option you did not create; a missing option is a question for the person.
- **One way to write.** Use the project's board script or tool if it has one, otherwise `gh project item-edit`. Never two tools for the same board in one run.
- **Read before you write.** Fetch the card's current status first; if a person moved it since your last write, leave it and note the difference in the situation line.
- **Board writes are visible to others.** They need the run's approval at intake, like any write outside the run folder.

## Standup summary

On request, from the run state and the board: in progress, waiting on review, ready to merge, merged, stopped with their gaps, and who each waits on. Active states only, in eight lines or fewer.

## Output

No verdict. Record each write in one `run.mjs note --kind info` per round of moves ("board: #12 In review, #13 Ready to merge"), and report any card you could not move.
