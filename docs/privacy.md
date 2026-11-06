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

`run.mjs push` writes to the `coordinator-state` branch of your repo (or of a private companion repo, if your repo is public): the run's event log, a snapshot, a readable summary, project lessons and one stats line per closed run. Secrets, your project path and your home folder are masked before anything is written. Nothing goes to a public repo. That branch is yours. The service writes to it only to add an answer or a note someone with push access made on the web or in a comment command, as one commit each.

## What the hosted service stores

| What | Why | Kept for |
|---|---|---|
| A copy of each run on the state branch, masked again, and its project map | To draw the dashboard | While the run is on the branch. Removed at the next sync after it leaves, and at once if you uninstall |
| Installed repos: name, private or public, branch tip, `coordinator.json`, project lessons | To know what to read and where to write | Until the repo is removed from the installation, or the App is uninstalled |
| Which issues and PRs each unit links | To keep their trackers and timelines current | Same as the run |
| For each tracker comment and board card made: the issue or PR, run and unit, the comment id and a hash of what was last written | To edit the same comment and card each time | Until the App is uninstalled (kept after the run leaves the branch, so a run that comes back reuses its comment) |
| Merges, closes and check results of linked PRs | To show them in the run's timeline | 180 days |
| Your session: GitHub user id and login, your GitHub token encrypted (AES-256-GCM) | To sign you in and ask GitHub what you can read | Until you sign out, or 7 days |
| Audit log (below) | Security, and so installation admins can see what happened | 90 days, also after an uninstall |
| Webhook delivery ids | To skip repeats | 14 days |
| Your alert settings: time zone, quiet hours, channels, whether alerts may include a question's text, and the repos you follow | To send you alerts the way you asked | Until you change them. A followed repo is dropped when it leaves the installation |
| Your alert email address, only after you confirm it from the link we send (the link expires in 24 hours; until then the address waits as pending) | Email alerts | Until you clear the field |
| Web push subscriptions: the push service's address and keys for each browser you turn push on in (at most 10) | Web push alerts | Until the browser unsubscribes or the push service says it is gone |
| Alerts made for you: run, unit, trigger, urgency, and whether each was sent, held for a digest or collapsed | Digests, collapsing repeats, and the Alerts view | 90 days |
| Comment commands handled: installation and comment id | To act on each comment once | 30 days |
| "May this person read this repo", per person | So every page doesn't ask GitHub again | In memory, at most 60 seconds, never shared between people |

Uninstalling the App deletes that installation's rows at once: runs, repos, links, trackers, merges and checks, handled comment commands, and the repos you followed there. Your alert settings, email, push subscriptions and alert history are yours rather than the installation's, and stay as above; so does the audit log, for its 90 days. Your repo keeps its state branch.

### The audit log

Each entry has a time, a kind, the installation (when there is one), the GitHub login involved (when there is one) and a few details. Nothing else.

| Kind | Details kept |
|---|---|
| `sign-in`, `sign-out` | The login |
| `access.refused` | The repo someone signed in tried to open without read access |
| `write.answer`, `write.note` | An answer or note made on the web: repo, run, what it was, the commit and event number |
| `write.refused` | An answer or note refused for want of push access: repo, run, kind |
| `command.answer`, `command.note` | The same for a comment command |
| `command.refused` | A comment command from someone without push access: repo, run |
| `doorbell.refused` | A doorbell token asked for a repo the person cannot read: the repo |
| `installation.created`, `.deleted`, `.suspend` and other installation actions | Who installed, removed or changed the App |
| `installation.repositories` | How many repos were added and removed |
| `sync.manual` | A sync run by an operator, and whether it was forced |
| `alert.sent` | Trigger, run, unit and channels of an alert sent to the login |
| `alerts.watch` | A repo someone started or stopped following |
| `alerts.access-lost` | A followed repo dropped because the person lost read access |
| `alerts.email-confirmed` | That someone confirmed an alert email (the address itself is not in the log) |

A security alert (secret scanning, code scanning, Dependabot) is kept only as its kind and number, inside the alert made for you.

**Not stored:** your GitHub email address, your source files (only what the run itself records about them, such as a project map's module names), any other file in your repos (apart from a linked repo's `coordinator.json`), any token GitHub gives the App to act on a repo (those last an hour and are never written down), the `gh` token the doorbell uses ([Permissions](permissions.md#the-doorbell-and-your-gh-token)), cookies or tokens in logs. The session cookie is kept only as a hash.

**Alert content is minimal by default:** a push or email says which run needs you and links to it. A question's text goes in only if you turn that on.

**Not done:** no model calls, no analytics or tracking, no advertising, no selling or sharing of data.

Server logs are JSON lines: one per request (method, path, status and timing; never headers, cookies, query strings or bodies), plus a few events. A sign-in logs the login ("signed in"), a refused token refresh logs the login, and a webhook whose signature fails logs the client IP address it came from. Secrets are masked in every line as a second net. They are kept for **[TO BE SET AT DEPLOY: log retention period]**.

## Who can see a run

Exactly the people who can read the state repo on GitHub. The service asks GitHub with the viewer's own sign-in on every page (cached for that person for at most 60 seconds). Someone without access gets the same "not found" as for a repo that does not exist.

## Questions

Open an issue at [github.com/mindmakr/coordinator](https://github.com/mindmakr/coordinator/issues), or see [SECURITY.md](../SECURITY.md) to report a problem privately.
