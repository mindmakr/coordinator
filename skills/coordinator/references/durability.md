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
- `payload.ops`: the change, as the smallest list of `set` (path, value), `del` (path) and `push` (path, values: an array grew). A path is keys and array indexes into the snapshot (canonical form, below). Replaying every event's ops from nothing gives the snapshot exactly. `run.imported` carries `payload.state` (the whole old state) instead; `run.init`'s single op sets the whole state.
- Kinds: `run.imported`, `run.init`, `run.freeze`, `run.integrate`, `run.stop` (`next` recorded stops), `run.close`, `unit.add`, `unit.start`, `unit.beat`, `unit.built`, `unit.reset`, `unit.verdict`, `unit.strategy`, `unit.detect`, `unit.link`, `behaviour`, `evidence`, `note`, `question`, `answer`, `answer.used`, and `state.edited` (below). `unit` is required for the `unit.*` kinds, optional for behaviour, evidence, note, question and the answers, absent otherwise.
- Every kind has a JSON Schema (`scripts/lib/eventschema.mjs`, `schemaFor(kind)`). Each event is checked when written and every line when read. A torn last line, a line that is not JSON, an unknown kind, a broken schema, or a `seq` that skips or repeats fails loudly, naming the line; nothing is guessed. Paths never contain `__proto__`, `constructor` or `prototype`.
- A step that changes nothing (`show`, `next` with no stop) writes no event.

### The snapshot

`state.json` is the state in canonical form (keys sorted; arrays of records with an `id` sorted by id, numbers inside ids compared as numbers, so `u2` comes before `u10`; other arrays in the order things happened), plus:

```json
"snapshot": { "v": 1, "seq": 42, "sha256": "<SHA-256 of events.jsonl up to and including line 42>", "stateSha256": "<SHA-256 of the state without this key>" }
```

- On read: the log ahead of the snapshot (a gap), a `sha256` that does not match the log, or an unreadable snapshot means the state is rebuilt from the events. A reader rebuilds in memory; the next write saves the rebuilt snapshot.
- A snapshot that names more events than the log holds, or names events when `events.jsonl` is missing, fails loudly: the log lost events. Restore it with `run.mjs pull`.
- A snapshot whose body no longer matches `stateSha256` was changed outside `run.mjs` (by hand, or by an older version of the scripts). It is kept: the next write first records the difference as a `state.edited` event, so the log still replays to the snapshot.

### Pit stops: the state in the repo

`S/run.mjs push <run>` copies the run to the primary repo so another machine can carry on. The lead calls it at **pit stops only**: a unit merged, a decision recorded, the run closed. Never on every event: the local log is the working copy between pit stops, and the repo's history stays one commit per pit stop.

- Where: an orphan branch, `coordinator-state` by default (`--to <branch>`), never `main`, `master` or the remote's default branch, and never a branch that does not already hold coordinator state. `--to ./folder` (or an absolute path) writes a folder instead. The commit is pushed to the repo's `origin` with a normal (non-force) push, retried on a race; a repo with no remote only gets the local branch. Nothing is checked out.
- What: `runs/<run>/events.jsonl`, `runs/<run>/state.json` (rebuilt from the copied events), `runs/<run>/README.md` (the workbench), `lessons/lessons.json` (project lessons), `stats/runs.jsonl` (one line per closed run: outcome, minutes, units, passed, rounds), and a root `README.md` and `.coordinator-state` marker. Evidence files never go.
- Masked: every string goes through the secret masking, the project path becomes `.` and the home folder `~`.
- Public repos: run state never goes into a public repo (design Q7). `.coordinator/coordinator.json` says where it may go: `{"visibility": "private" | "internal" | "public", "stateRepo": "<URL or path of a private companion repo>", "remote": "origin", "branch": "coordinator-state"}`, all optional. Without `visibility`, the GitHub CLI is asked; if nobody can tell, the push is refused. A public repo needs `stateRepo`, and then only the companion repo is written.
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
