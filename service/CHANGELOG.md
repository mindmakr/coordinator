# Changelog: Coordinator service

## Unreleased

- **First release (#11): GitHub App and read-only web dashboard.** Webhook ingest of the `coordinator-state` branch (signature checked, deliveries de-duplicated, unchanged tips and logs not read again, every log validated with the skill's event schema and masked again), a Postgres read model (in memory without `DATABASE_URL`), sign-in through the App's user authorisation, a per-request read-permission check with GitHub (cached per person for 60 s; no access is a 404), and the projects, runs, run, unit and coordinator pages drawn by the skill's own renderers. Manual sync from a repo page or `npm run sync`. Dockerfile, docker compose for local Postgres, App manifest and Dokploy notes in the README. AGPL-3.0.
