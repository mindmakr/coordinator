# /coordinator init

Learn the project once, so that every later run starts informed and asks only about the task, and set up what the coordinator needs on this machine (where run state goes, theme, budgets, merge rule, hosted app). It ends by running doctor.

## Steps

1. **Read before asking.** Look at the README, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, any `.agents/` profile, the package scripts, the CI files, the branch list, and the project's own skills. Infer everything you can.
2. **Ask only what is left**, in one batch, each question with your recommended answer first. Typical gaps:
   - Which branch work goes into, and which branches are protected.
   - Whether a run may merge into the working branch when the review passes, or only open the PR.
   - Which checks prove a change: the exact commands, and whether any need a database or service. Which tests cover which files or sides (backend, frontend, shared contract, migration), so builders and critics run only those, and the one full-suite command (`guardrails.md`, Test runs).
   - Which screen widths each surface needs (for example, admin desktop only, end-user phone and desktop), and for web or Expo apps whether the project uses [reins](https://github.com/mindmakr/reins) (or wants the `reins` skill to set it up) so builders and visual critics can drive actions, read state and snap panels without pixel clicking.
   - Risk areas the critic must always check, such as money, auth, migrations, time zones, or a simulated clock.
   - The review skill or reviewer to use, if any.
   - How the person wants to be told: only at the end, or also when a unit stops.
   - Whether to route models (recommended: on): mechanical builder work such as docs, copy and translations on a cheaper model, critics always on the strongest (`references/routing.md`). Write the answer with `S/run.mjs init --models on|off` (key `models` in `.coordinator/coordinator.json`).
3. **Write `COORDINATOR.md` at the project root** with the headings below. Keep it short, with one line per fact and its source. It is shared with the team, so commit it if they agree. It holds no secrets.

```
# Coordinator context
## Work flow        base branch, protected branches, PR rules
## Checks           commands that prove a change, what each needs, which tests map to which files or sides, the full-suite command
## Risk areas       what a critic must always check here, and screen widths per surface
## Review           the review skill or reviewer, and what "ready" looks like
## Standing rules   actions pre-approved for every run (e.g. "merge into test when review is READY")
## Never            actions that need a person every time
## Isolation        how builders get their own worktree, database, ports
```

4. Add `.coordinator/` to `.gitignore`.
5. **Setup questions**, below, then run doctor and show its result.

## Setup questions

What the coordinator needs on this machine. Ask them in the same batch as step 2, through the question tool, each with your recommendation first. On a re-run, read `.coordinator/coordinator.json` and `COORDINATOR.md` first, show each current value as the first option ("Keep: …"), and change only what the person changes.

| Question | Options (recommended first) | Written to |
|---|---|---|
| Where does run state go? | Private repo: the `coordinator-state` branch of this repo, at pit stops (when the repo is private) · A private companion repo (when this repo is public; ask its name) · Local only | `state` (`repo` or `local`), `stateRepo`, `visibility` |
| The dashboard's theme file? | The project's design-system CSS you found (e.g. `app/globals.css`) · Built-in theme | `theme`, and a `Theme:` line in `COORDINATOR.md` |
| Default budgets per unit? | 4 rounds, 240 minutes (or the `stats` 80th percentile + 1 when there are closed runs) · Other | `budgets: { rounds, minutes }` |
| Which branches may a run merge into when the review passes? | The working branch you found (e.g. `test`) · None: open the PR only | `merge: [branches]`, and a line under `## Standing rules` |
| Connect the hosted app (web dashboard, answers from anywhere)? | Not now · Yes: ask for its URL (https) | `service` |
| Small helper models for summaries, picks and first looks at screenshots (`references/helpers.md`)? | Ollama on this machine (when `ollama` is installed) · LM Studio on this machine · A router (OpenRouter, OpenAI, other): its key stays in an environment variable · Not now | `helpers`, written with `S/helper.mjs setup <provider>`; then run `S/helper.mjs ping` and show its fix line |

Leave other keys to their own questions (model routing: `models`). Write `.coordinator/coordinator.json` with only the keys answered; merge into what is there, never drop a key the person did not change. The file is local (`.coordinator/` is ignored) and holds no secrets: never a token, a password or a URL with credentials.

`coordinator.json` keys, all optional (checked by `scripts/lib/settings.mjs`):

| Key | Value | Used by |
|---|---|---|
| `state` | `local` (run state never leaves this machine; `push` to a branch is refused) or `repo` | `run.mjs push` |
| `visibility` | `private`, `internal` or `public` (else `gh` is asked) | `push` |
| `stateRepo` | a private companion repo, `owner/name` or URL | `push`, `pull`, `watch --remote` |
| `remote`, `branch` | where `push` writes (`origin`, `coordinator-state`) | `push` |
| `service` | the hosted app's URL, https (http only on localhost) | `watch --remote` |
| `theme` | a `.css` file; `COORDINATOR.md`'s `Theme:` line wins | the dashboard |
| `budgets` | `{ "rounds": 1-8, "minutes": 5-10080, "launchMinutes": 1-600, "launchCost": "0.50 USD" }` (launch caps off when absent) | `run.mjs init` defaults; flags still win |
| `merge` | branch names a run may merge into on a pass; `[]` = PR only | the lead (`guardrails.md`) |
| `models` | `false` (routing off), absent (built-in routing), or `{ strong, critic, specialist, visual-critic, integrator, builder, researcher, mechanical, or a task class: model name }`; doctor warns when a judge is below `strong` | staffing (`team.md`) |
| `helpers` | absent (off) or `{ provider, endpoint, keyEnv, models: { decide, summarize, look }, minConfidence }`; `keyEnv` names an environment variable, never a key | `helper.mjs` (`helpers.md`) |

Then run `node <skill-dir>/scripts/doctor.mjs` and show its lines. Fix what the answers cover; list the rest as the person's to-do, each with its fix line.

## Updating it

If a run learns a lasting project fact (a check that was missing, a risk area that bit), propose a one-line change to `COORDINATOR.md` in the retro. The person approves it; the lead never edits it silently.
