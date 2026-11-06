# Durable runs

A run can outlive a context window, a crash, or the person going away. The event log is the run, and memory is only a cache of it.

## State

- `.coordinator/runs/<run>/events.jsonl` is the run: one event per change, append only. `state.json` beside it is a snapshot derived from the events (goal, bar, fence, budget, units, rounds, notes and decisions), which every reader uses.
- State written by an older version still loads: fields added later (a round's `cause`, behaviours, evidence, a unit's log and links) are optional. A `state.json` with no `events.jsonl` (0.5 and older) loads as it is; its first change writes a `run.imported` event holding it, then the change.
- Every write happens behind the run's lock file and is atomic (a temporary file renamed over the real one): the event first, then the snapshot. Two writers cannot corrupt the run; a lock older than 30 s is taken over.
- `.coordinator/runs/<run>/workbench.md`, `hud.html` and `units/<unit>.html` are rewritten after every change, inside the same lock. Evidence files live in `artifacts/<unit>/` beside them. People read them from anywhere, so nobody has to interrupt the loop to ask how it's going (`hud.md`).
- Add `.coordinator/` to `.gitignore`. It is working state, not a deliverable.

### The event log

Each line of `events.jsonl` is one compact JSON object, keys in this order:

```json
{"v":1,"seq":7,"at":"2026-11-06T10:41:07.120Z","kind":"unit.beat","unit":"u1","payload":{"ops":[{"op":"set","path":["units",0,"heartbeatAt"],"value":"2026-11-06T10:41:07.118Z"}]}}
```

- `v`: schema version, 1. `seq`: 1, 2, 3 … with no gap. `at`: ISO time, UTC. `kind`: what happened. `unit`: the unit it concerns, when there is one.
- `payload.ops`: the change, as the smallest list of `set` (path, value), `del` (path) and `push` (path, values: a list grew). A path is object keys, plus, inside a list, either `{ "id": "u1" }` for lists of records with ids (units, behaviours, evidence) or an index for lists without (notes, rounds, a unit's log). So `unit.add` is one `push` to `units` carrying the whole unit, and a later change reads `["units", {"id": "u1"}, "status"]`: each event makes sense on its own, and no event depends on where a unit sits in the list. Replaying every event's ops from nothing gives the snapshot exactly. `run.imported` carries `payload.state` (the whole old state) instead; `run.init`'s single op sets the whole state.
- Kinds: `run.imported`, `run.init`, `run.freeze`, `run.integrate`, `run.stop` (`next` recorded stops), `run.close`, `unit.add`, `unit.start`, `unit.beat`, `unit.built`, `unit.reset`, `unit.verdict`, `unit.strategy`, `unit.detect`, `unit.link`, `behaviour`, `evidence`, `note`, `study`, `question`, `answer`, `answer.used`, and `state.edited` (below). `unit` is required for the `unit.*` kinds, optional for behaviour, evidence, note, question and the answers, absent otherwise.
- Every kind has a JSON Schema (`scripts/lib/eventschema.mjs`, `schemaFor(kind)`). Each event is checked when written and every line when read. A torn last line, a line that is not JSON, an unknown kind, a broken schema, or a `seq` that skips or repeats fails loudly, naming the line; nothing is guessed. Paths never contain `__proto__`, `constructor` or `prototype`.
- A step that changes nothing (`show`, `next` with no stop) writes no event.

### The snapshot

`state.json` is the state in canonical form, on one line: keys sorted, lists in the order things happened (units in the order they were planned, so a stacked unit follows its base, as `next` and the dashboard list them), plus:

```json
"snapshot": { "v": 1, "seq": 42, "sha256": "<SHA-256 of events.jsonl up to and including line 42>", "stateSha256": "<SHA-256 of the state without this key>" }
```

- On read: the log ahead of the snapshot (a gap), a `sha256` that does not match the log, or an unreadable snapshot means the state is rebuilt from the events. A reader rebuilds in memory; the next write saves the rebuilt snapshot.
- A snapshot that names more events than the log holds, or names events when `events.jsonl` is missing, fails loudly: the log lost events. Restore it with `run.mjs pull`.
- A snapshot whose body no longer matches `stateSha256` was changed outside `run.mjs` (by hand, or by an older version of the scripts). It is kept: the next write first records the difference as a `state.edited` event, so the log still replays to the snapshot.
- The snapshot repeats the text the events hold (goals, notes, evidence). Every reader (`show`, the dashboard, `watch`, `serve`, the coordinator's own page) reads the whole state from it, and a snapshot that pointed into the log would make each of them replay the run. Text is capped where it is written, so the copy stays small.

### Pit stops: the state in the repo

`S/run.mjs push <run>` copies the run to the primary repo so another machine can carry on. The lead calls it at **pit stops only**: a unit merged, a decision recorded, the run closed. Never on every event: the local log is the working copy between pit stops, and the repo's history stays one commit per pit stop.

- Where: an orphan branch, `coordinator-state` by default (`--to <branch>`), never `main`, `master` or the remote's default branch, and never a branch that does not already hold coordinator state. `--to ./folder` (or an absolute path) writes a folder instead. The commit is pushed to the repo's `origin` with a normal (non-force) push, retried on a race; pre-push hooks run, and one that fails fails the push with its message (the commit is built with `git commit-tree`, so pre-commit and commit-msg hooks do not run). A repo with no remote only gets the local branch. Nothing is checked out.
- Only forward: a push refuses, and changes nothing, unless the copy's `events.jsonl` for the run is a prefix of this machine's (masked) log, or differs from it only by answers and person notes this machine has already replayed (below). A copy with events this machine lacks needs a `pull` first; two machines that both added events after the same point stop with "different histories after event N", the same words `pull` uses. To recover from different histories: move the local run folder (`.coordinator/runs/<run>`) aside, `run.mjs pull <run>`, then redo the local changes on top; both errors say so.
- What: `runs/<run>/events.jsonl`, `runs/<run>/state.json` (rebuilt from the copied events), `runs/<run>/README.md` (the workbench), `lessons/lessons.json` (project lessons), `stats/runs.jsonl` (one line per closed run: outcome, minutes, units, passed, rounds), and a root `README.md` and `.coordinator-state` marker. Evidence files never go.
- The project map, when a pit stop staged one (`run.mjs map <run> --pit-stop`): `runs/<run>/map/events.jsonl` and `map.md`, under the same forward-only rule, restored by `pull` (`map.md` has the details).
- Masked: every string goes through the secret masking, the project path becomes `.` and the home folder `~`.
- Public repos: run state never goes into a public repo (design Q7). `.coordinator/coordinator.json` says where it may go: `{"visibility": "private" | "internal" | "public", "stateRepo": "<URL or path of a private companion repo>", "remote": "origin", "branch": "coordinator-state"}`, all optional. Without `visibility`, the GitHub CLI is asked; if nobody can tell, the push is refused. A public repo needs `stateRepo`, and then only the companion repo is written.
- Answers and notes from the web dashboard or a `/coordinator` comment command are appended to the copy's `events.jsonl` by the service (the same `answer` / `note` events). After asking a question, push (a pit stop), and `pull` at the next loop step. When the local log is no further than the copy, `pull` fast-forwards onto them. When the lead has logged more since its push (beats, verdicts), the two logs differ after the push, and `pull` replays the copy's extra events on the local log instead: only if every one is an `answer` or a person's `note` (`note --kind person`) and does nothing else; each goes through the same checks and lock as `run.mjs answer` and `note`, in the copy's order, as new local events (seq renumbered, the original time kept). Anything else in the copy's extra events, or an answer or note with fields `run.mjs` never writes, stops with "different histories" and changes nothing; so does an answer that names an option the question lacks. An answer to a question the lead has already used (or closed by a decision), typically changed on the web before the lead's push showed the use, does not change it: the lead keeps the used answer, and the change is recorded as a person's note flagged `changedAfterUse` ("answer changed after use: qN → …", design 9), which the service alerts on. A second `pull` adds nothing. The next `push` then replaces the copy's log with the local one, which holds every replayed event; a push while the copy still has answers or notes the local log lacks is refused ("pull first"). `lib/incoming.mjs`.
- `S/run.mjs pull <run> [--from <branch>|./folder]` on another machine restores the run (and the project lessons, if it has none), or appends the copy's newer events to the local log. A local log with events the copy lacks is never overwritten: pull says `local-ahead`, or refuses when the two histories differ.

## Background agents

- Start builders and critics as background agents. The harness notifies the lead when one finishes, so never poll and never sleep-loop.
- Long checks, such as full test suites, builds or visual sweeps, run as background commands that write a log file. The agent reports the log path and the pass or fail line.
- The agent beats with `run.mjs beat <run> <unit>` at each milestone: it pushed, the tests ran, the review finished. The builder and critic briefs carry the exact command. `next` returns `check-stale` for a builder or critic with no beat for `--stale-minutes`.
- **Stale:** first ask the agent for its status. If there's no answer:
  - with `phase: building`, `start` the unit again and send a fresh builder from the last pushed state;
  - with `phase: judging`, the build is kept: `beat` the unit and send a fresh critic.
- **Where the state is:** `.coordinator/` sits beside the main checkout, so builders in git worktrees of the same repo reach it with no setup. An agent working anywhere else (another clone, another machine path) gets `COORDINATOR_DIR=<dir>` in its brief; `S/run.mjs where` prints the value.

## Resume

After compaction, a restart or a new session:

1. Run `S/run.mjs list`, then `S/run.mjs show <run>`.
2. For each in-progress unit, check its branch, worktree or output for the latest real state. A unit with no artifact goes back to build with `S/run.mjs reset <run> <unit> --reason "…"`, so nobody waits out the stale timer.
3. Run `S/run.mjs next <run>` and carry on.

## Isolation

- Code: one worktree and one branch per builder, created from the current base. Install dependencies in each worktree. Never link `node_modules` or other shared folders between worktrees: deleting one can delete the other.
- Databases or services shared with other work: give each builder its own database or port, recorded in the unit's notes.
- Stacked work, where B builds on A: B branches from A's branch, rebases after A merges, and opens its PR only then (`run.mjs add … --after A`).
