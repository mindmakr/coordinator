# Permissions

What the Coordinator GitHub App asks for, and why. The hosted App and one you register from [`service/app-manifest.json`](../service/app-manifest.json) ask for the same.

GitHub grants an App permissions per repo, and only on the repos you install it on. Pick the repos one by one.

## Repository permissions

| Permission | Level | Used for |
|---|---|---|
| Metadata | Read | Required by GitHub for every App: repo names and visibility |
| Contents | Read & write | Reading the `coordinator-state` branch, and committing answers and notes to it. GitHub can't limit this to one branch, so the service limits itself: it only ever moves `refs/heads/coordinator-state`, never `main`, `master` or a branch without the coordinator marker |
| Issues | Read & write | The one tracker comment per unit on an issue, edited in place; reading comment commands and reacting or replying to them |
| Pull requests | Read & write | The tracker comment on a PR, and knowing when a run's PR is merged, closed or reopened |
| Checks | Read | Whether the checks on a run's PR went green or red |
| Secret scanning alerts | Read | A security alert when GitHub finds a secret in a run's repo. Optional |
| Code scanning alerts | Read | The same for code scanning findings. Optional |
| Dependabot alerts | Read | The same for vulnerable dependencies. Optional |

The three alert permissions are optional: leave them out of your own App and the service simply sends no security alerts. Of a security alert, the service keeps only its kind and number.

## Organisation permissions

| Permission | Level | Used for |
|---|---|---|
| Projects | Read & write | Setting the **Run** and **Unit state** fields (and Status, if you map it) on each unit's card, and creating those two fields once. Only used when `coordinator.json` names a board. Leave it out of your own App to run without boards |

## Events

| Event | Used for |
|---|---|
| `push` | Re-reading the state branch when it changes. Pushes to other branches are ignored |
| `issue_comment` | Comment commands: `/coordinator answer q3 b` and `/coordinator note "…"`. One strict line is read; the rest of the comment is ignored |
| `pull_request` | Merges, closes and reopens of PRs a run links |
| `check_suite` | Check results on those PRs |
| `secret_scanning_alert`, `code_scanning_alert`, `dependabot_alert` | Security alerts on a run's repos (new, reopened, or appearing in a branch) |
| Installation events | Adding and removing repos (always sent by GitHub) |

## Narrower than the App

Each token the service mints is cut down to one job, whatever the App holds:

| Job | Token can |
|---|---|
| Reading run state | Read contents and metadata. Nothing else |
| Committing a comment command's answer or note | Write contents, for the state repo alone (`repository_ids`), so it cannot write any other repo of the installation |
| Tracker comments | Write issues and PRs. No code, no boards |
| Board fields | Write organisation projects; read issues and PRs |

Installation tokens last an hour, are minted per job and are never stored.

## Your own sign-in

When you sign in, GitHub gives the service a user token that expires and refreshes. Pages use **your** token to ask GitHub whether you can read a repo, so you see exactly the repos GitHub lets you see; the answer is reused for you alone, for at most 60 seconds. An answer or note from the web is committed with your token, so git history shows who answered, and only if GitHub says you can push to the repo. The token is stored encrypted and dropped when you sign out.

## The doorbell and your `gh` token

`run.mjs watch --remote` can ask the service to ring when a run changes, so an answer reaches the lead in seconds rather than at the next poll. To get a doorbell token it sends your `gh auth token` once to `POST /doorbell/token`. The service uses it to check you can read the repo, returns a 15-minute token for that one repo, and does not keep your GitHub token. But that token is your whole `gh` login, often with broad scopes, so it reaches the service each time a doorbell token is minted. A short-lived token for this App alone (device login) is planned and not built yet. Until then, set `COORDINATOR_SERVICE` only to a service you run or trust, over https. Without it the skill polls the branch and sends no token anywhere.

## Not asked for

Actions, workflows, repository secrets, administration, members, and your email address on GitHub. An email for alerts is one you type in and confirm ([Privacy](privacy.md)).

## How much one installation or address can use

What GitHub lets the App read is one thing; how much of the service one tenant can take is another. These keep one installation, or one client address, from crowding out the rest:

- **Webhooks, per client address:** deliveries that fail the signature check, are too large (over 5 MB), too slow (not in full within 10 seconds) or cut short count as refusals; past 30 a minute, that address is answered 429 before its body is read, except deliveries addressed to this App. Bodies being read at once are capped per address (5 MB, 1 MB of it for small bodies) and in all (32 MB). The address is the connection's, or with `TRUST_PROXY=1` the last `X-Forwarded-For` entry: behind a proxy, set it, or every client shares one address and one allowance.
- **Reading logs, per installation:** logs are read in a small pool of worker threads (`PARSE_WORKERS`, default 2), taken in turn per installation; a large log (over `PARSE_SMALL_KB`, default 512 KB) never takes the last worker. Each installation has `PARSE_BUDGET_SECONDS` of reading time per hour (default 600); past it, its logs wait for the next resync. One sync of one repo reads at most `SYNC_MAX_MB` of logs (default 64); the rest follow at the next sync.

Every limit and its default is in [Self-host](self-host.md#limits-per-client-address).

## Where writes go

- Answers and notes: only to `coordinator-state` in the state repo.
- Tracker comments and board fields: only to the state repo and to linked repos that agreed on both sides ([Connect](connect.md#3-coordinatorjson-on-the-state-branch-optional)). Comments are capped at 200 per installation per 10 minutes, and a run with more than 50 units is refused.

If you registered your own App before this release, raise Contents to write, add the three alert permissions and the new events in its settings, then accept the new permissions on each installation.
