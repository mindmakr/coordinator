# Connect a repo

Connecting is optional. Without it, Coordinator works as before: state in `.coordinator/` on your machine, the dashboard on `127.0.0.1`. Connected, you can follow every run from any browser or phone, and each issue and PR a run works on gets one tracker comment, kept current.

Three steps: the state branch, the GitHub App, and (optionally) `coordinator.json`.

## 1. The state branch

At pit stops (a unit merged, a decision recorded, the run closed) the lead runs:

```
node <skill>/scripts/run.mjs push <run>
```

That copies the run to an orphan branch, `coordinator-state`, in your repo: its event log, a snapshot, a readable `README.md`, project lessons and one stats line per closed run. Secrets, your project path and your home folder are masked first. The first push creates the branch. Nothing is checked out and `main` is never touched.

On another machine, `run.mjs pull <run>` picks the run up.

**Public repos.** Run state never goes into a public repo. Create a private companion repo (for example `acme/web-coordinator`) and name it in `.coordinator/coordinator.json` on your machine:

```json
{ "visibility": "public", "stateRepo": "git@github.com:acme/web-coordinator.git" }
```

Then only the companion repo is written. Without `visibility`, the push asks the GitHub CLI; if nobody can tell, it refuses.

**Your CI.** A push made with your own token triggers workflows that run `on: push` with no branch filter. Add the state branch to their ignore list, so state pushes cost no Actions minutes:

```yaml
on:
  push:
    branches-ignore: [coordinator-state]
```

## 2. The GitHub App

**Hosted (beta, free):** open [app.coordinator.mindmakr.com](https://app.coordinator.mindmakr.com), sign in with GitHub, and install the Coordinator App on the repos whose runs you want to see. Pick repos one by one rather than "All repositories".

**Self-hosted:** register your own App from the manifest instead. See [Self-host](self-host.md).

Once installed, the App reads `coordinator-state` whenever it changes, and every 15 minutes as a safety net. You see the runs of every repo you can read on GitHub, and nothing else; GitHub decides, with your own sign-in. [Permissions](permissions.md) lists what the App can do and why.

## 3. coordinator.json on the state branch (optional)

For trackers on other repos, or a board, put a `coordinator.json` at the root of the `coordinator-state` branch:

```json
{
  "repos": ["acme/mobile"],
  "trackers": true,
  "board": { "owner": "acme", "number": 3,
             "status": { "building": "In progress", "judging": "In review", "passed": "Done",
                         "stopped": "Blocked", "needs you": "Blocked" } }
}
```

| Key | What |
|---|---|
| `repos` | Linked repos whose issues and PRs may get tracker comments |
| `trackers` | `false` turns tracker comments off for this project |
| `board` | An organisation's Projects board. Each unit's card gets a **Run** and a **Unit state** field. With `status`, the board's own Status follows too |

**Linked repos agree on both sides.** The App writes to a linked repo only if that repo's default branch also has a `coordinator.json` naming the primary:

```json
{ "primary": "acme/web" }
```

Anyone who can push to the state branch can edit its `coordinator.json`, so it cannot name other repos on its own. The second side needs push access to the linked repo's default branch.

Boards owned by a personal account can't be reached by an App; use an organisation board.

## Disconnect

Uninstall the App in GitHub (Settings → Applications). The hosted service deletes that installation's data at once ([Privacy](privacy.md)). The `coordinator-state` branch stays in your repo; delete it if you no longer want it.
