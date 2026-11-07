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
| Installed repos: name, private or public, branch tip, `coordinator.json`, project lessons, and whether a forced re-read is under way (`reread`) | To know what to read and where to write, and to finish a forced re-read over several syncs | Until the repo is removed from the installation, or the App is uninstalled |
| Ids of uninstalled installations, with the time (`uninstalled`): a number and a date, nothing about the account | GitHub never reuses an installation id, so a late or replayed event for a removed installation is refused instead of bringing it, and its data, back | For good |
| Which issues and PRs each unit links | To keep their trackers and timelines current | Same as the run |
| For each tracker comment and board card made: the issue or PR, run and unit, the comment id and a hash of what was last written | To edit the same comment and card each time | Until the App is uninstalled. Kept after the run leaves the branch or the repo leaves the installation, so a run that comes back reuses its comment |
| Merges, closes and check results of linked PRs | To show them in the run's timeline | 180 days |
| Your session: GitHub user id and login, your GitHub token encrypted (AES-256-GCM) | To sign you in and ask GitHub what you can read | Until you sign out, or 7 days |
| Audit log (below) | Security, and so installation admins can see what happened | 90 days. Rows about an installation go when it is uninstalled (below) |
| Webhook delivery ids, and a SHA-256 hash of each delivery's body (not the body) | To skip a delivery GitHub repeats, or a signed body replayed under a new id | 14 days |
| Your alert settings: time zone, quiet hours, channels, whether alerts may include a question's text, and the repos you follow | To send you alerts the way you asked | Until you change them. A followed repo is dropped when it leaves the installation |
| Your alert email address, only after you confirm it from the link we send (the link expires in 24 hours; until then the address waits as pending, with a hash of the link's token). Stored normalised: Unicode NFKC, and the domain in its ASCII (IDNA) form, so one address cannot be entered in two spellings | Email alerts | Until you clear the field, or follow the unsubscribe link in any alert email |
| Web push subscriptions: the push service's address and keys for each browser you turn push on in (at most 10) | Web push alerts | Until the browser unsubscribes or the push service says it is gone |
| Alerts made for you: run, unit, trigger, urgency, and whether each was sent, held for a digest or collapsed | Digests, collapsing repeats, and the Alerts view | 90 days. Deleted at once when the repo leaves the installation or the App is uninstalled |
| Comment commands handled: installation and comment id | To act on each comment once | 30 days |
| "May this person read this repo", per person | So every page doesn't ask GitHub again | In memory, at most 60 seconds, never shared between people |
| Rate counters (below) | To keep one client or tenant from crowding out the rest | In memory, for their window. A restart resets them |
| GitHub's published webhook address ranges (from `GET /meta`, public) | To tell GitHub's deliveries from others' | In memory, refreshed daily |

**Uninstalling the App** deletes everything about that installation at once: runs, repos, links, trackers, merges and checks, handled comment commands, the alerts made for its repos (sent or waiting for a digest), everyone's follows of its repos, and its audit rows. Two things stay: one audit row, `installation.deleted`, with who removed it (for 90 days), and the installation's id in `uninstalled` (above). What is yours rather than the installation's stays as above: your session, alert settings, email and push subscriptions, and audit rows about you that name no installation (sign-in and sign-out, refused access, email confirmed or unsubscribed). Your repo keeps its state branch.

**Removing one repo** from the installation deletes its runs, links, follows and the alerts made for it.

**The unsubscribe link** in every alert email is signed with a key derived from the service's secret, over your user id and address. Nothing is stored to make it; following it clears your alert email and turns email alerts off.

### Rate counters

Kept in memory only, each for its own window, and reset by a restart. A "client address" is grouped: an IPv6 address counts as its /64 (one host usually has a whole /64), an IPv4 address as itself, except for webhook bytes, where IPv4 counts by /24:

| Counted by | What | Window |
|---|---|---|
| Client address group (see `TRUST_PROXY` in [Self-host](self-host.md)) | Page views; sign-in attempts; doorbell tokens; refused webhook deliveries | 1 minute; 10 minutes; 10 minutes; 1 minute |
| Webhook address group (IPv4 /24, IPv6 /64), outside GitHub's hook addresses | Webhook body bytes being read, at most 512 KB per group | While the body is read (at most 10 seconds) |
| Mailbox: the email address in lower case, without a `+tag`, and for Gmail (or googlemail.com) without dots | Confirmation emails sent to it, so `ann+1@` and `ann+2@` count as one | 24 hours |
| GitHub user id | Confirmation emails asked for; answers and notes from the web; "Sync now" | 24 hours; 1 minute; 10 minutes |
| Commenter id (per installation) | Comment commands | 1 hour |
| Installation | Comment commands, refusal replies, tracker comment writes, and reading time for its logs | 1 hour; 1 hour; 10 minutes; 1 hour |

### Parse-time budgets

Run and map logs are read in a small pool of worker threads, in turn per installation. Each installation has a reading-time budget per hour (`PARSE_BUDGET_SECONDS`, 600 by default); past it, its logs wait for the next resync. One read that takes more than 20 seconds is stopped and recorded as an error. One sync of one repo reads at most `SYNC_MAX_MB` of logs (64 MB). Only the time spent and the installation are counted, in memory.

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
| `doorbell.refused` | A doorbell token asked for a repo the person cannot read (the repo), or a doorbell stream closed because its holder lost read access (the installation) |
| `installation.created`, `.deleted`, `.suspend` and other installation actions | Who installed, removed or changed the App |
| `installation.repositories` | How many repos were added and removed |
| `sync.manual` | A sync run by an operator, and whether it was forced |
| `alert.sent` | Trigger, run, unit and channels of an alert sent to the login |
| `alerts.watch` | A repo someone started or stopped following |
| `alerts.access-lost` | A followed repo dropped because the person lost read access |
| `alerts.email-confirmed` | That someone confirmed an alert email (the address itself is not in the log) |
| `alerts.unsubscribed` | That someone stopped alert email from the link in an email (the login; not the address) |

A security alert (secret scanning, code scanning, Dependabot) is kept only as its kind and number, inside the alert made for you.

**Not stored:** your GitHub email address, your source files (only what the run itself records about them, such as a project map's module names), any other file in your repos (apart from a linked repo's `coordinator.json`), any token GitHub gives the App to act on a repo (those last an hour and are never written down), the `gh` token the doorbell uses ([Permissions](permissions.md#the-doorbell-and-your-gh-token)), cookies or tokens in logs. The session cookie is kept only as a hash.

**Alert content is minimal by default:** a push or email says which run needs you and links to it. A question's text goes in only if you turn that on.

**Not done:** no model calls, no analytics or tracking, no advertising, no selling or sharing of data.

Server logs are JSON lines: one per request (method, path, status and timing; never headers, cookies, query strings or bodies), plus a few events. Lines that name a person: "signed in" and a failed token refresh carry the login; an opened doorbell stream, an alert that could not be delivered and a failed access check carry the login too. Lines that carry a client address: a webhook whose signature is refused, and a webhook body that arrived too slowly. They log the address group: a full IPv4 address, or an IPv6 address cut to its /64. Secrets are masked in every line as a second net. They are kept for **[TO BE SET AT DEPLOY: log retention period]**.

## Who can see a run

Exactly the people who can read the state repo on GitHub. The service asks GitHub with the viewer's own sign-in on every page (cached for that person for at most 60 seconds). Someone without access gets the same "not found" as for a repo that does not exist.

## Questions

Open an issue at [github.com/mindmakr/coordinator](https://github.com/mindmakr/coordinator/issues), or see [SECURITY.md](../SECURITY.md) to report a problem privately.
