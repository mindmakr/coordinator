# Self-host

The hosted service at [app.coordinator.mindmakr.com](https://app.coordinator.mindmakr.com) and a self-hosted one run the same code from `service/`. Self-hosting needs one container, Postgres, and a GitHub App you register yourself. Your App is private to you; it never talks to ours.

The service code and its full reference are in [`service/README.md`](../service/README.md). Licence: AGPL-3.0.

## 1. Register your GitHub App

The App is made from [`service/app-manifest.json`](../service/app-manifest.json), which asks only for the [permissions](permissions.md) the service uses.

1. In a copy of the manifest, replace `https://coordinator.example.com` with your public address (`BASE_URL`) in all four places.
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

3. Check it: `curl http://127.0.0.1:3000/healthz` answers `ok`. The service applied its migrations (`service/sql/001` to `007`) before it began listening; `docker compose -f service/docker-compose.yml logs service` shows a `listening` line, or `could not start` with the cause.
4. Stop it with `docker compose -f service/docker-compose.yml down` (add `-v` to delete the database too).

To reach it from the internet, put it behind a reverse proxy with HTTPS on your domain, set `BASE_URL` to that domain and `TRUST_PROXY=1`, and change the `ports` line in `docker-compose.yml` if the proxy runs elsewhere.

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
4. Add the domain with HTTPS, container port 3000.
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
| `TRUST_PROXY` | behind a proxy | `1` to read the client address from `X-Forwarded-For` |
| `PORT` | no | Default 3000 |
| `STATE_BRANCH` | no | Default `coordinator-state` |
| `ACCESS_TTL_SECONDS` | no | How long a "may read this repo" answer is reused, per person. Default and maximum 60 |
| `SESSION_DAYS` | no | Default 7 |
| `MAX_CONNECTIONS` | no | Default 1000 |
| `RESYNC_MINUTES` | no | Re-read every installation this often. Default 15; 0 turns it off |
| `TRACKERS`, `BOARD` | no | `off` turns tracker comments or board fields off everywhere |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Email alerts. Without `SMTP_HOST`, no email. Port 587 by default; `SMTP_SECURE=1` for TLS from the start (465) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | no | Web push alerts (`npx web-push generate-vapid-keys`). Both keys or neither; the subject is a `mailto:` or `https:` URL |
| `ALERT_SWEEP_SECONDS` | no | How often quiet leads are looked for and due digests sent. Default 60 |
| `DOORBELL_MAX_STREAMS` | no | Open doorbell streams at most. Default 500; 0 turns the doorbell off |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | no | Another GitHub host. Defaults `https://api.github.com` and `https://github.com`; other hosts are untested |

## Backups

Back up Postgres if you want to keep sign-ins, alert settings and the audit log. Nothing else needs it: every run is rebuilt from the repos' `coordinator-state` branches on the next sync.

## Upgrades

Pull, rebuild, redeploy. Migrations in `service/sql/` run at start, in order.
