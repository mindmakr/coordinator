-- The read model. Everything here can be rebuilt from the coordinator-state
-- branches (design G2), except sessions and the audit log.

CREATE TABLE installations (
  id          bigint PRIMARY KEY,
  account     text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repos (
  installation_id bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id              bigint NOT NULL,
  full_name       text NOT NULL,
  head_sha        text,
  synced_at       timestamptz,
  sync_error      text,
  lessons         jsonb,
  PRIMARY KEY (installation_id, id)
);
CREATE INDEX repos_full_name ON repos (lower(full_name));

CREATE TABLE runs (
  installation_id bigint NOT NULL,
  repo_id         bigint NOT NULL,
  run_id          text NOT NULL,
  events_sha      text,
  seq             integer,
  state           jsonb,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, repo_id, run_id),
  FOREIGN KEY (installation_id, repo_id) REFERENCES repos(installation_id, id) ON DELETE CASCADE
);

CREATE TABLE deliveries (
  id   text PRIMARY KEY,
  at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash            text PRIMARY KEY,
  user_id            bigint NOT NULL,
  login              text NOT NULL,
  token_enc          text NOT NULL,
  refresh_enc        text,
  token_expires_at   timestamptz,
  refresh_expires_at timestamptz,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE audit (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  kind            text NOT NULL,
  installation_id bigint,
  login           text,
  detail          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_at ON audit (at);
