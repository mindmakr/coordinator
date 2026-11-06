# Privacy

Coordinator runs on your machine. The hosted service at [app.coordinator.mindmakr.com](https://app.coordinator.mindmakr.com) only shows what your runs already put on GitHub, to the people GitHub lets read it. This page says what it keeps and for how long. It describes the hosted beta; a self-hosted service keeps the same things in your own database.

## What never leaves your machine

- Your code as it runs: worktrees, checkouts, builds and tests.
- Builder and critic transcripts, and the prompts and replies of your model.
- Model API keys, `.env` files and every other credential.
- Test and build logs, beyond the short evidence lines your lead writes into the run.
- Evidence files (screenshots, logs). The web dashboard shows them as "file kept locally".
- Everything under `.coordinator/` until the lead runs `run.mjs push` at a pit stop.

## What goes to GitHub, and only if you connect

`run.mjs push` writes to the `coordinator-state` branch of your repo (or of a private companion repo, if your repo is public): the run's event log, a snapshot, a readable summary, project lessons and one stats line per closed run. Secrets, your project path and your home folder are masked before anything is written. Nothing goes to a public repo. That branch is yours; the service never writes to it.

## What the hosted service stores

| What | Why | Kept for |
|---|---|---|
| A copy of each run on the state branch, masked again, and its project map | To draw the dashboard | While the run is on the branch. Removed at the next sync after it leaves, and at once if you uninstall |
| Installed repos: name, private or public, branch tip, `coordinator.json`, project lessons | To know what to read and where to write | Until the repo is removed from the installation, or the App is uninstalled |
| Which issues and PRs each unit links, and the tracker comment and board card made for each | To edit the same comment and card each time | Same as the run |
| Merges, closes and check results of linked PRs | To show them in the run's timeline | 180 days |
| Your session: GitHub user id and login, your GitHub token encrypted (AES-256-GCM) | To sign you in and ask GitHub what you can read | Until you sign out, or 7 days |
| Audit log: sign-ins, refused access, installs and removals, with the login involved | Security | 90 days |
| Webhook delivery ids | To skip repeats | 14 days |
| "May this person read this repo", per person | So every page doesn't ask GitHub again | In memory, at most 60 seconds, never shared between people |

Uninstalling the App deletes that installation's rows at once. Your repo keeps its state branch.

**Not stored:** your email address, your source files (only what the run itself records about them, such as a project map's module names), any other file in your repos (apart from a linked repo's `coordinator.json`), any token GitHub gives the App to act on a repo (those last an hour and are never written down), cookies or tokens in logs. The session cookie is kept only as a hash.

**Not done:** no model calls, no analytics or tracking, no advertising, no selling or sharing of data.

Server logs carry the request path, status and timing, never headers, cookies or query strings.

## Who can see a run

Exactly the people who can read the state repo on GitHub. The service asks GitHub with the viewer's own sign-in on every page (cached for that person for at most 60 seconds). Someone without access gets the same "not found" as for a repo that does not exist.

## Questions

Open an issue at [github.com/mindmakr/coordinator](https://github.com/mindmakr/coordinator/issues), or see [SECURITY.md](../SECURITY.md) to report a problem privately.
