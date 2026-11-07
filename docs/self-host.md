# Self-host

The hosted service at [app.coordinator.mindmakr.com](https://app.coordinator.mindmakr.com) and a self-hosted one run the same code from `service/`. Self-hosting needs one container, Postgres, and a GitHub App you register yourself. Your App and your service are yours alone: they never talk to ours, and nothing you store reaches us.

The service code and its full reference are in [`service/README.md`](../service/README.md). Licence: AGPL-3.0.

## 1. Register your GitHub App

The App is made from [`service/app-manifest.json`](../service/app-manifest.json), which asks only for the [permissions](permissions.md) the service uses.

1. In a copy of the manifest, replace `https://coordinator.example.com` with your public address (`BASE_URL`) in all four places.
   Then change `"public": true` to `"public": false`. The manifest is the hosted App's, and `true` lets any GitHub account install it. With `false`, only the account or organisation that owns the App can install it, which is what a self-hosted service is for. Keep `true` only if you mean to serve other people's accounts too; then their runs, sign-ins and alert settings are stored in your database, and [Privacy](privacy.md) describes what you would be keeping for them.
2. Save this as a local HTML file, paste the manifest into `value`, and open it in a browser. For an organisation, post to `https://github.com/organizations/<org>/settings/apps/new` instead.

   ```html
   <form action="https://github.com/settings/apps/new" method="post">
     <input type="hidden" name="manifest" value='PASTE app-manifest.json HERE'>
     <button>Create the Coordinator App</button>
   </form>
   ```

3. GitHub creates the App and sends you to `BASE_URL/?code=…`. Within an hour, swap the code for the App's keys:

   ```
   gh api -X POST /app-manifests/<code>/conversions
   ```

   It returns `id`, `slug`, `client_id`, `client_secret`, `webhook_secret` and `pem`. They go into the service's environment, never into a repo.
4. In the App's settings, leave "Expire user authorization tokens" on.
5. Install the App on the repos whose runs you want to see.

## 2. Run it

### Docker Compose (one machine)

The service and Postgres together, both bound to `127.0.0.1`. From the repository root:

1. Copy the settings file and fill it in:

   ```
   cp service/.env.example service/.env
   ```

   Set `SESSION_SECRET` (`openssl rand -base64 48`) and the `GITHUB_*` values from step 1. Leave `DATABASE_URL` as it is: Compose replaces it with its own database (`db:5432` inside the Compose network).
2. Build and start:

   ```
   docker compose -f service/docker-compose.yml up --build -d
   ```

3. Check it: `curl http://127.0.0.1:3000/healthz` answers `ok`. The service applied its migrations (`service/sql/001` to `008`) before it began listening; `docker compose -f service/docker-compose.yml logs service` shows a `listening` line, or `could not start` with the cause.
4. Stop it with `docker compose -f service/docker-compose.yml down` (add `-v` to delete the database too).

To reach it from the internet, put it behind a reverse proxy with HTTPS on your domain, set `BASE_URL` to that domain and `TRUST_PROXY=1`, and change the `ports` line in `docker-compose.yml` if the proxy runs elsewhere. See [Behind a proxy](#behind-a-proxy) first: with `TRUST_PROXY=1` the service's port must be reachable from the proxy alone.

### Docker, with your own Postgres

```
docker build -f service/Dockerfile -t coordinator-service .
docker run -d -p 127.0.0.1:3000:3000 --env-file service/.env coordinator-service
```

Here `DATABASE_URL` in `service/.env` must name a host the container can reach. `localhost` is the container itself, not your machine: use the database's own host name, or `host.docker.internal` for a Postgres on the same machine (Docker Desktop; on Linux add `--add-host=host.docker.internal:host-gateway`).

### Dokploy

1. Create a Postgres database in the Dokploy project and copy its internal connection string.
2. Create an application from this repository: build type Dockerfile, Dockerfile path `service/Dockerfile`, build context `.`.
3. Set the environment (below), with `DATABASE_URL` from step 1, `BASE_URL` set to your domain and `TRUST_PROXY=1`. Mount the App key as a file and set `GITHUB_APP_PRIVATE_KEY_FILE`, or paste it into `GITHUB_APP_PRIVATE_KEY`.
4. Add the domain with HTTPS, container port 3000. Don't publish the port on the host: Traefik reaches the container over Dokploy's network, and nothing else should (see [Behind a proxy](#behind-a-proxy)).
5. Deploy. Point the App's webhook at `https://<domain>/webhook`.

### Repos installed before the service was up

Their install events went nowhere, so read them once by hand, from the repository's `service/` folder, or the container's terminal (`docker compose -f service/docker-compose.yml exec service npm run sync -- <installation-id>` with Compose):

```
npm run sync -- <installation-id>
```

The installation id is the number at the end of the installation's settings page: on GitHub, **Settings → Applications → Installed GitHub Apps → Configure** next to your App (for an organisation, **Organization settings → GitHub Apps**); the address ends in `/installations/<id>`. Run it once per installation. Later installs arrive by webhook, and every installation the service knows is re-read every 15 minutes.

## Environment

| Variable | Needed | What |
|---|---|---|
| `BASE_URL` | yes | Public address, `https://…` outside localhost |
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -base64 48`). Derives the key that encrypts people's GitHub tokens at rest |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` | yes | From step 1.3 |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE` | yes | The App's PEM: one line with `\n`, or a mounted file |
| `DATABASE_URL` | for real use | Postgres. Unset, everything is kept in memory and lost on restart |
| `GITHUB_APP_SLUG` | no | Shows an "install the App" link |
| `TRUST_PROXY` | behind a proxy | `1` to read the client address from the last `X-Forwarded-For` entry. Every per-address limit (below) uses it: behind a proxy without it, all clients share the proxy's address, and one busy or hostile client uses up everyone's allowance. The port must then be reachable from the proxy alone ([Behind a proxy](#behind-a-proxy)) |
| `TRUSTED_PROXY_HOPS` | behind a CDN | How many proxies in front each add an `X-Forwarded-For` entry: the client is that many from the end. Default 1; 2 for a CDN in front of the proxy (1–5). Only with `TRUST_PROXY=1` |
| `PORT` | no | Default 3000 |
| `STATE_BRANCH` | no | Default `coordinator-state` |
| `ACCESS_TTL_SECONDS` | no | How long a "may read this repo" answer is reused, per person. Default and maximum 60 |
| `SESSION_DAYS` | no | Default 7 |
| `MAX_CONNECTIONS` | no | Open connections the server accepts at once. Default 1000 (10–100000) |
| `RESYNC_MINUTES` | no | Re-read every installation this often. Default 15; 0 turns it off |
| `TRACKERS`, `BOARD` | no | `off` turns tracker comments or board fields off everywhere. Default: on |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Email alerts. Without `SMTP_HOST`, no email. Port 587 by default; `SMTP_SECURE=1` for TLS from the start (465). `SMTP_FROM` defaults to `Coordinator <coordinator@localhost>`, which most mail servers refuse: set it to an address your server may send from |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | no | Web push alerts (`npx web-push generate-vapid-keys`). Both keys or neither; the subject is a `mailto:` or `https:` URL |
| `ALERT_SWEEP_SECONDS` | no | How often quiet leads are looked for and due digests sent. Default 60 |
| `DOORBELL_MAX_STREAMS` | no | Open doorbell streams at most. Default 500; 0 turns the doorbell off |
| `PARSE_WORKERS` | no | Worker threads that read run and map logs, so a slow log never blocks the server. A large log never takes the last one. Default 2 (1–32). With 1, a large log may take the only worker, on purpose, so small reads wait behind it: the guarantee that a small read never waits behind a large one needs at least 2 |
| `PARSE_SMALL_KB` | no | A log up to this size counts as small and may use any worker. Default 512 (1–16384) |
| `PARSE_BUDGET_SECONDS` | no | Reading time each installation gets per hour. Past it, its logs wait for the next resync. Default 600 (1–3600) |
| `SYNC_MAX_MB` | no | Log bytes one sync of one repo reads; the rest follow at the next sync. A forced sync (`npm run sync -- <id> --force`) that needs more is marked in the database and carried on by every later sync until it is done. Default 64 (8–4096) |
| `SYNC_CONCURRENCY` | no | Repo syncs that run at once, in all. A push for a repo already waiting joins that sync. Default 4 (1–64) |
| `SYNC_PER_INSTALLATION` | no | Of those, how many one installation may run; installations take turns. Default 2 (1–64) |
| `SYNC_BLOB_MB` | no | Memory the logs being read may take, in all. Each log counts 5 times its size (GitHub's base64 text, the parsed string, the bytes, the worker's copy and the text read from it), and is fetched only when it fits. Default 192 (16–4096) |
| `SYNC_JOB_SECONDS` | no | One sync of one repo stops reading after this; the rest follow at the next sync. Default 300 (10–1200) |
| `TRAIL_CONCURRENCY` | no | Trail refreshes (tracker comments, board cards) at once, in all. They run after the sync has given its slot back, so a slow trail never holds a sync slot. Default 4 (1–64) |
| `TRAIL_PER_INSTALLATION` | no | Of those, how many one installation may run; installations take turns. Default 1 (1–64) |
| `TRAIL_READS` | no | GitHub calls one installation's trail may make per 10 minutes, other than comment writes (searches for the App's own comment, board queries and field writes, a linked repo's `coordinator.json`). Past it the run stays owed and a later sync carries on. Default 300 (10–100000) |
| `WEBHOOK_SOURCES` | no | Who counts as GitHub for webhooks: `github` (default: GitHub's published hook ranges), a comma-separated list of CIDRs (for GitHub Enterprise Server), or `any` ([Webhook sources](#webhook-sources)) |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | no | Another GitHub host. Defaults `https://api.github.com` and `https://github.com`; other hosts are untested |

## Behind a proxy

With `TRUST_PROXY=1` the service believes `X-Forwarded-For`. Anyone who can reach its port directly can write that header and pose as any address: they get a fresh allowance of every per-address limit with each request, and can pose as GitHub's hook addresses. So the service's port must be reachable from the proxy alone:

- **Docker Compose:** keep the `127.0.0.1:` binding in `ports`, or drop `ports` and put the proxy on the Compose network.
- **Dokploy:** don't publish port 3000 on the host; Traefik reaches the container over its own network.
- **A firewall** in front of the host should allow 80 and 443 only.

**A CDN in front of the proxy** (Cloudflare, CloudFront, Fastly): each of the two adds an entry, so set `TRUSTED_PROXY_HOPS=2`. Otherwise every client is the CDN's address, all share one allowance, and GitHub's deliveries arrive from the CDN rather than from GitHub's addresses, so they lose the webhook reserve kept for GitHub (`WEBHOOK_SOURCES` in [`service/README.md`](../service/README.md#webhook-sources)). Three more things then hold:

- The CDN must add to `X-Forwarded-For`, not replace it (the usual default), and the proxy must keep the CDN's entry: in Traefik, list the CDN's ranges in the entry point's `forwardedHeaders.trustedIPs`, or it drops the header and adds only the CDN's address.
- The proxy must accept connections from the CDN's ranges alone. A client that reaches the proxy directly adds its own entry, and with 2 hops its forged one before it is read as the client.
- Don't let the CDN cache or retry `/webhook`.

## Limits per client address

The service counts these in memory, per client address (see `TRUST_PROXY`), and a restart resets them. All IPv6 addresses of one /64 count as one address, since one host is usually given a whole /64:

| What | Limit |
|---|---|
| Webhook deliveries that fail the signature check, are too large, too slow or cut short | 30 a minute; past that, deliveries are answered 429 before their body is read. One from GitHub's hook addresses naming this App is always read |
| Webhook bodies being read at once | 512 KB per address group (IPv4 /24, IPv6 /64) outside GitHub's hook addresses, so filling the budget takes 52 groups; a larger body from there is refused (413). 32 MB in all, of which the last 6 MB only GitHub's addresses may use, and only for deliveries that name this App ([Webhook sources](#webhook-sources)). A body must arrive within 10 seconds |
| Page views | 600 a minute |
| Sign-in attempts | 30 per 10 minutes |
| Doorbell tokens | 30 per 10 minutes |

Other limits count per person or per installation instead: syncs (`SYNC_CONCURRENCY` at once, `SYNC_PER_INSTALLATION` per installation, each stopping after `SYNC_JOB_SECONDS`), trail refreshes (`TRAIL_CONCURRENCY` at once, `TRAIL_PER_INSTALLATION` per installation, `TRAIL_READS` GitHub calls per 10 minutes per installation),  answers and notes (30 a minute per person), "Sync now" (6 per 10 minutes per person), comment commands (10 an hour per commenter, 60 an hour per installation), confirmation emails (3 a day per person, and 3 a day per mailbox: the address in lower case without a `+tag`, and for Gmail without dots), and tracker comment writes (200 per 10 minutes per installation).

## Webhook sources

GitHub sends webhooks from published address ranges (`hooks` in `GET /meta`). With `WEBHOOK_SOURCES=github`, the default, the service fetches them from `GITHUB_API_URL/meta` when it starts and every 24 hours, and uses a built-in copy until a fetch succeeds. A later failed fetch keeps the last fetched list. Only those addresses may use the last 6 MB of the webhook budget, and only from them does the App's own delivery header skip the limit on refused deliveries. Behind a proxy that hides the real address (see [Behind a proxy](#behind-a-proxy)), GitHub looks like everyone else and loses that reserve.

GitHub's addresses also deliver every other repo's and App's hooks, so anyone can point their own hooks at this service. From those addresses, only a delivery that names this App (`X-GitHub-Hook-Installation-Target-Type: integration` and `X-GitHub-Hook-Installation-Target-ID` the App id) is uncapped and may use the reserve. Any other counts under the hook target it names, capped at 512 KB like an address group, and stays out of the reserve.

- A list of CIDRs is used as given and never fetched: use it for GitHub Enterprise Server.
- `any` trusts no address: every address group gets the same 512 KB, bodies of 64 KB or less may use the reserve, and the App header is believed from anyone. Use it only when you cannot see client addresses at all.

The list lives in memory; nothing is stored.

On a Docker host whose container network has no IPv6, IPv6 clients may reach Traefik through docker-proxy with the network gateway's address, so they all share one address group. If you serve IPv6, enable IPv6 in the Docker network.

## Backups

Back up Postgres if you want to keep sign-ins, alert settings and the audit log. Nothing else needs it: every run is rebuilt from the repos' `coordinator-state` branches on the next sync.

## Upgrades

Pull, rebuild, redeploy. Migrations in `service/sql/` run at start, in order.
