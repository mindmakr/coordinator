# Permissions

What the Coordinator GitHub App asks for, and why. The hosted App and one you register from [`service/app-manifest.json`](../service/app-manifest.json) ask for the same.

GitHub grants an App permissions per repo, and only on the repos you install it on. Pick the repos one by one.

## Repository permissions

| Permission | Level | Used for |
|---|---|---|
| Metadata | Read | Required by GitHub for every App: repo names and visibility |
| Contents | Read | Reading the `coordinator-state` branch. GitHub can't limit this to one branch, so the service limits itself: it only ever reads that branch |
| Issues | Read & write | The one tracker comment per unit on an issue, created and then edited in place |
| Pull requests | Read & write | The tracker comment on a PR, and knowing when a run's PR is merged, closed or reopened |
| Checks | Read | Whether the checks on a run's PR went green or red |

## Organisation permissions

| Permission | Level | Used for |
|---|---|---|
| Projects | Read & write | Setting the **Run** and **Unit state** fields (and Status, if you map it) on each unit's card, and creating those two fields once. Only used when `coordinator.json` names a board. Leave it out of your own App to run without boards |

## Events

| Event | Used for |
|---|---|
| `push` | Re-reading the state branch when it changes. Pushes to other branches are ignored |
| `pull_request` | Merges, closes and reopens of PRs a run links |
| `check_suite` | Check results on those PRs |
| Installation events | Adding and removing repos (always sent by GitHub) |

## Narrower than the App

Each token the service mints is cut down to one job, whatever the App holds:

| Job | Token can |
|---|---|
| Reading run state | Read contents and metadata. Nothing else |
| Tracker comments | Write issues and PRs. No code, no boards |
| Board fields | Write organisation projects; read issues and PRs |

Installation tokens last an hour, are minted per job and are never stored.

## Your own sign-in

When you sign in, GitHub gives the service a user token that expires and refreshes. Pages use **your** token to ask GitHub whether you can read a repo, so you see exactly the repos GitHub lets you see. The answer is reused for you alone, for at most 60 seconds. The token is stored encrypted and dropped when you sign out.

## Not asked for

- **Contents: write.** Not until answers and notes from the web arrive (planned for a later release). Then it will write only to `coordinator-state`.
- **Actions, workflows, secrets, administration, members, email.** Never used.
- **Security alerts.** Not used yet.

## Where writes go

Tracker comments and board fields go only to the state repo and to linked repos that agreed on both sides ([Connect](connect.md#3-coordinatorjson-on-the-state-branch-optional)). Comments are capped at 200 per installation per 10 minutes, and a run with more than 50 units is refused.
