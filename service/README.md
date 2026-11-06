# Coordinator service

A GitHub App and a web dashboard for [Coordinator](../README.md) runs, plus the GitHub trail: one tracker comment and one board card per unit, kept current. The lead pushes a run's state to the `coordinator-state` branch at pit stops (`run.mjs push`, see [durability.md](../skills/coordinator/references/durability.md)); this service reads that branch when GitHub says it changed and shows each run to the people who can read the repo, from any browser or phone.

Design: [docs/design/v1.md](../docs/design/v1.md), sections 6 (GitHub as the visible trail), 7 (web HUD), 10 (hosting) and 11 (security). Milestone 0.6 (#11) is the read side; 0.7 (#12) adds answers and notes from the web and from comment commands (alerts and the doorbell are separate).

Licence: [AGPL-3.0](LICENSE). The skill and its shared code stay MIT.

## What it does

| Part | How |
|---|---|
| Ingest | `POST /webhook` takes `push` events for `coordinator-state` and installation events. The signature (`X-Hub-Signature-256`) is checked on the raw body before parsing. It reads the branch with an installation token (read-only, minted per sync, never stored), validates every `runs/<run>/events.jsonl` with the skill's own event schema, replays it, masks secrets again, and stores the state. A repeated delivery id is skipped; an unchanged branch tip or log blob is not read again. A log that fails validation keeps the last good copy and shows why. |
| Sign-in | GitHub App user authorisation (user-to-server tokens, which expire and refresh). A random `state` in a short-lived HttpOnly cookie guards the round trip. |
| Access | Every repo page asks GitHub, with the viewer's own token, whether they can read the repo; the answer is reused for that person only, for 60 s. No access, no repo, and a repo re-created under the same name all give the same 404. |
| Pages | Projects (repos you can read), runs of a repo, run dashboard, unit pages with their timelines, the run's maps, its project map (when the run pushed one), and the coordinator page, drawn by the skill's own renderers, so they look like the local dashboard. No scripts. The run and unit pages carry the answer and note forms (below); evidence files stay on the person's machine and show as "file kept locally". |
| Merges and checks | `pull_request` (closed, merged, reopened) and `check_suite` (completed) events are stored against the PR and shown in the run's and unit's timelines (badged "(GitHub)"), to viewers who can read the PR's repo too. They also refresh the tracker comments and board cards of every run that links the PR. |
| Tracker comments | One comment per unit on each issue or PR it links, marked `<!-- coordinator:tracker run=… unit=… -->` and edited in place (template: the skill's `lib/tracker.mjs`, so the lead writes the same text). State, tries and scores, open questions, merge and check results, and a link to the unit's page. The last gap, cause and question headers appear only when the comment is in the run's own repo and that repo is private; elsewhere it is status only. Every piece of run text sits in an inline code span, so it renders no Markdown, HTML, links or mentions. Unchanged text is never re-sent; a deleted comment is re-made. Only repos in the run's project are written (below). |
| Board | When `coordinator.json` on the state branch names an organisation board, each unit's card gets **Run** (text) and **Unit state** (building, judging, passed, stopped, needs you); the two fields are created on first use. With a `status` map, the board's own Status follows too. Cards not on the board are left alone; nothing else is created or renamed. |
| Answers and notes (web) | Open questions on the run and unit pages have the same answer form as the local dashboard (options, recommended first, "Other", changeable until the lead uses it), plus a note form for the run and each unit. A post (`/r/<owner>/<repo>/run/<run>/answer` or `/note`) needs this site's Origin and the session's CSRF token, and GitHub, asked again with the person's own token, must say they can push to the repo; readers see the forms disabled with the reason. The answer is committed to `runs/<run>/events.jsonl` on the state branch with the person's own token (so git history shows who answered), as the same `answer` / `note` event `run.mjs` writes, with the run's `state.json` and `README.md` rewritten beside it. The write is optimistic: build on the branch tip, move it without force, and on a race read again and retry (5 tries). The lead's next `run.mjs pull` fast-forwards onto it. 30 writes a minute per person. |
| Comment commands | `/coordinator answer q3 <option label>`, `/coordinator answer q3 "your own answer"` and `/coordinator note <text>` in a comment on an issue or PR that a unit of exactly one open run links. Only the first line starting with `/coordinator` is read (not inside a `>` quote or a code fence); bots and edits are ignored; each comment is handled once (`comment_commands`, migration 006). The commenter needs push access to the run's state repo, asked of GitHub. The service reacts 👀, then 👍 when the event is written (installation token narrowed to contents, authored as the commenter), or 😕 and a short reply saying why not. Replies quote neither the comment nor the run. |
| Manual sync | "Sync now" on a repo page (rate limited), or `npm run sync -- <installation-id>` (`--all`, `--force`). |

Shared code: [src/core.mjs](src/core.mjs) imports the skill's `scripts/lib` (event schema, replay, rules, view, renderers, maps, tracker template, secret masking). Nothing is copied; the container image carries that folder beside the service. Extra pages add themselves to `REPO_PAGES` in [src/pages.mjs](src/pages.mjs): `scope: 'repo'` for a page beside a repo's runs, `scope: 'run'` for one under a run. The project map is one: `/r/<owner>/<repo>/run/<run>/map`, read from `runs/<run>/map/events.jsonl` on the state branch (`run.mjs map <run> --pit-stop`, then `push`), checked and replayed with the skill's own `lib/map/log.mjs`, linked from the run's header next to Maps. A map log that fails keeps the last good map and says why.

### coordinator.json (optional, on the state branch)

```json
{
  "repos": ["acme/mobile"],
  "trackers": true,
  "board": { "owner": "acme", "number": 3,
             "status": { "building": "In progress", "judging": "In review", "passed": "Done", "stopped": "Blocked", "needs you": "Blocked" } }
}
```

**Writes stay in the project.** Comments and board fields go only to the state repo and to linked repos that agree on both sides: the state branch's `coordinator.json` lists the repo in `repos`, and that repo's own default branch has a `coordinator.json` with `"primary": "<state repo>"` (for example `{ "primary": "acme/web" }` in acme/mobile). The run log and the state branch can be written by anyone who can push to the state repo, so they cannot be trusted to name other repos on their own; the second side can only be written by someone who can push to the linked repo's default branch and pass its branch protection. A link to any other repo, even one the App is installed on, is shown read-only to viewers who can read it and never written to. The agreement is re-checked at most every 60 seconds, so a repo that withdraws gets no further edits after that.

`"trackers": false` turns the comments off for that repo. Without `board`, no board is touched. Boards owned by a personal account are not reachable by an App; use an organisation board. `TRACKERS=off` or `BOARD=off` in the environment turns either off everywhere.

## Run it locally

Needs Node 20+ and Docker (for Postgres).

```bash
cd service
npm ci
docker compose up -d db            # Postgres on 127.0.0.1:5452
cp .env.example .env               # fill in the GitHub App values and SESSION_SECRET
node --env-file=.env src/main.mjs  # http://localhost:3000
```

Without `DATABASE_URL` the service keeps everything in memory, which is enough to look around. `docker compose up --build` runs the service in a container too.

To get webhooks on a laptop, point the App's webhook URL at a tunnel (for example `gh webhook forward` or smee.io) or skip webhooks and use `npm run sync -- <installation-id>`.

### Tests

```bash
npm test                                                                   # unit and HTTP tests, in-memory database
TEST_DATABASE_URL=postgres://coordinator:coordinator-dev@127.0.0.1:5452/coordinator npm test   # also the Postgres adapter
```

The Postgres test drops and re-creates the service's tables in that database, so use a throwaway one. The tests use a fake GitHub (`test/helpers.mjs`) and runs made with the skill's own CLI. They cover the webhook signature, ingest idempotency and every kind of malformed log, the permission check (a reader, a writer and an outsider; an outsider gets 404), escaping on every page, CSRF and origin checks, cookies and rate limits.

## Settings

All from the environment; [.env.example](.env.example) lists them. Nothing secret goes in the database or the logs: GitHub tokens are encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET`), the session cookie is stored only as a hash, and log lines carry no headers, cookies or query strings.

| Variable | Needed | What |
|---|---|---|
| `BASE_URL` | yes | Public origin, `https://…` outside localhost |
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -base64 48`) |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` | yes | From the App |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE` | yes | The App's PEM (one line with `\n`, or a mounted file) |
| `DATABASE_URL` | for real use | Postgres connection string |
| `GITHUB_APP_SLUG` | no | Shows an "install the App" link |
| `TRUST_PROXY` | behind a proxy | `1` to read the client address from `X-Forwarded-For` (last entry) for rate limits |
| `PORT`, `STATE_BRANCH`, `ACCESS_TTL_SECONDS` (max 60, design 10.3), `SESSION_DAYS`, `MAX_CONNECTIONS` | no | Defaults 3000, `coordinator-state`, 60, 7, 1000 |
| `TRACKERS`, `BOARD` | no | `off` turns tracker comments or board fields off for every repo |
| `RESYNC_MINUTES` | no | How often every installation is re-read (default 15, 0 turns it off) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Email alerts. Unset `SMTP_HOST`: no email (alerts skip it). Port 587 by default; `SMTP_SECURE=1` for TLS from the start (465) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | no | Web push alerts (`npx web-push generate-vapid-keys`). Both keys or neither; the subject is a `mailto:` or `https:` URL |
| `ALERT_SWEEP_SECONDS` | no | How often leads gone quiet are looked for and due digests are sent (default 60) |
| `DOORBELL_MAX_STREAMS` | no | Open doorbell streams at most (default 500; 0 turns the doorbell off) |

## Alerts and the doorbell

**Alerts** (design 9). People pick the repos they hear about on `/alerts` (each checked with their own GitHub access, and re-checked whenever they open the page), and set there: an email address (used only after they follow the confirmation link), channels (web push, email, GitHub mention), their time zone and quiet hours, and whether a question's text may be included.

| Trigger | Channels | Urgency |
|---|---|---|
| A new open question | push, email, GitHub mention | normal |
| A unit stopped | push, email | normal |
| A run closed | email | low |
| A linked PR merged | push | low |
| Checks went red on a linked PR | push | normal |
| A secret, code scanning or Dependabot alert on a run's repo | push, email, GitHub mention | high: ignores quiet hours |
| A lead went quiet (units mid-work, no sign of life on the branch for twice the run's stale budget) | push | normal |
| An answer changed after the lead used it | push | normal |

- Content is minimal: repo, run, unit, what happened and a link to the page. A question's text is added to push and email only for people who opted in and whose access was confirmed in the last 7 days; a GitHub mention never carries it, and goes only on an issue or PR in the state repo itself.
- One alert per thing: the same trigger on the same unit within 15 minutes bumps the first alert's count.
- Low and normal alerts in quiet hours wait; when the hours end, one digest goes by email and push.
- Every alert, and what happened on each channel ("sent", "off", "not configured", "no address", "failed"), is listed on `/alerts` and in the audit log. A channel that is not configured is skipped; the rest still go.
- Push subscriptions are accepted only for the browsers' own push services (Google, Mozilla, Apple, Microsoft), since the service posts to them.
- For security alerts, give the App "Secret scanning alerts", "Code scanning alerts" and "Dependabot alerts" (read) and the matching events; they are optional.

**The doorbell** (design 3.2, option C) lets `run.mjs watch <run> --remote` pull within seconds of a change instead of at its next poll (every 30 s). `POST /doorbell/token?repo=owner/name` with the person's GitHub token as a Bearer returns a doorbell token for that one repo, valid 15 minutes, if GitHub says they can read it; the GitHub token is used for that check and not kept. `GET /doorbell?run=<run>` with that token is a Server-Sent Events stream of `changed` events carrying only `{ "run": "<id>" }`; it ends when the token expires, and the skill mints a new one (and so re-checks access). Without the doorbell, or when it fails, polling still delivers within 60 s.

## Register the GitHub App

[app-manifest.json](app-manifest.json) asks for the least each part needs. Every installation token is also narrowed when it is minted to the one job it is for (`SCOPES` in [src/github.mjs](src/github.mjs)), so the ingest token can only read, and the comment token cannot touch the board or the code.

| Permission | Level | Used by | Why |
|---|---|---|---|
| Metadata | read | everything | Required by GitHub |
| Contents | write | ingest, answers and notes | Read the `coordinator-state` branch, and commit answers and notes to it. GitHub grants contents per repo, not per branch; the service only ever moves `refs/heads/<STATE_BRANCH>`, never `main`, `master` or a branch without the `.coordinator-state` marker (`stateBranchOnly` and `commitRun` in [src/writes.mjs](src/writes.mjs), tested). A ruleset that keeps the App off every other branch is good defence in depth |
| Issues | write | tracker comments, comment commands | Create and edit the one tracker comment per unit; reactions and replies to commands; `issue_comment` events |
| Pull requests | write | tracker comments, merge events | Comments on PRs; `pull_request` events |
| Checks | read | check events | `check_suite` events |
| Organization projects | write | board | Set the Run, Unit state and Status fields; create the two coordinator fields once. Leave it out to run without a board |

Events: `push`, `pull_request`, `check_suite`, `issue_comment`, and for security alerts `secret_scanning_alert`, `code_scanning_alert`, `dependabot_alert` (installation events always arrive). An App registered before 0.7 needs Contents raised to write, the three security alert permissions added, and these events added in its settings; each installation then accepts the new permissions.

1. Replace `https://coordinator.example.com` in the manifest with your `BASE_URL`.
2. Save this as a local HTML file, paste the manifest into the `value`, and open it (for an organisation, use `https://github.com/organizations/<org>/settings/apps/new`):

   ```html
   <form action="https://github.com/settings/apps/new" method="post">
     <input type="hidden" name="manifest" value='PASTE app-manifest.json HERE'>
     <button>Create the Coordinator App</button>
   </form>
   ```
3. GitHub creates the App and redirects to `BASE_URL/?code=…`. Exchange the code within an hour:
   `gh api -X POST /app-manifests/<code>/conversions` returns `id`, `slug`, `client_id`, `client_secret`, `webhook_secret` and `pem`. Put them in the environment, never in the repo.
4. In the App's settings, keep "Expire user authorization tokens" on.
5. Install the App on the repos whose runs you want to see.

## Deploy on Dokploy

One container plus Postgres:

1. Create a Postgres database in the Dokploy project and copy its internal connection string.
2. Create an application from this repository, build type Dockerfile, Dockerfile path `service/Dockerfile`, build context the repository root (`.`).
3. Environment: everything in the table above, with `DATABASE_URL` from step 1, `BASE_URL` set to the domain, and `TRUST_PROXY=1`. Mount the App key as a file and set `GITHUB_APP_PRIVATE_KEY_FILE`, or paste it into `GITHUB_APP_PRIVATE_KEY`.
4. Domain: add it with HTTPS (Let's Encrypt), container port 3000.
5. Deploy. Migrations run at start. `GET /healthz` answers `ok`.
6. Point the App's webhook at `https://<domain>/webhook`, then run `npm run sync -- --all` from the container's terminal once to pick up repos installed before the service was up.

Logs go to stdout as JSON lines. Deleting the database loses nothing but sessions and the audit log: a sync rebuilds every run from the repos.

## Known limits

- **"A lead went quiet" is a guess from the state branch.** The service sees only what the lead pushes, and the lead pushes at pit stops (a unit merged, a decision, the run closing), not at every heartbeat. The alert fires when a run has units mid-work and the newest time in the pushed state (a heartbeat, round, note or start) is older than twice the run's stale budget (`staleMinutes`, 45 by default, so 90 minutes) ([src/alerts/triggers.mjs](src/alerts/triggers.mjs), `quietSince`). So a lead that is working well but has not reached a pit stop for that long is reported quiet, and a lead that stopped right after a push is not reported until the same time has passed. It is sent once per quiet spell, at normal urgency, and only by push; treat it as "worth a look", not as proof the lead is down. The lead's own machine (`run.mjs watch`, the local dashboard) knows better.

## Security notes

- Webhooks: the HMAC SHA-256 is always checked first, in constant time, with a 5 MB body cap. A delivery that verifies is never rate limited: GitHub sends every App's hooks from a few shared addresses, so someone else's misconfigured hook must not block ours. Only refused deliveries are counted (30 a minute per address, then 429 for refused ones only).
- Every installation is re-read every `RESYNC_MINUTES` (15), so a missed or failed delivery heals on its own; an unchanged branch costs one ref read.
- One run log cannot fan out: a run with more than 50 units is refused, at most 10 links per unit are written to, and comment writes are capped at 200 per installation per 10 minutes (the rest wait for the next sync).
- Sign-in: 30 tries per 10 minutes per address; `state` compared in constant time; PKCE (S256) on the code exchange; a new session on every sign-in, dropping the old one; after sign-in only this service's own page paths are followed.
- Cookies: HttpOnly, SameSite=Lax, `Secure` and `__Host-` prefixed on https.
- Every POST needs this site's `Origin` and the session's CSRF token. An answer or note also needs push access, asked of GitHub with the person's own token on every write (the page's disabled forms are only a hint).
- Comment text is data: one strict line is parsed, nothing else in the comment is read, and a command can only answer a question the lead asked or add a note (design 11.3).
- Every page: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, `no-store`, `nosniff`, `X-Frame-Options: DENY`, HSTS on https.
- An unknown repo is checked with GitHub exactly like a known one the viewer cannot read, so response time does not reveal which repos the service knows.
- Run state, lessons, `coordinator.json` and maps nested deeper than 64 levels are refused with a sync error, never a crash.
- Every repo and run query is scoped by installation id (`src/db/index.mjs` refuses a call without one); permission answers are cached per person, never shared.
- Uninstalling the App deletes that installation's rows at once.
