-- Alerts (design 9): each person's settings, the repos they asked to hear
-- about, their web push subscriptions, and every alert made for them (sent,
-- waiting in a quiet-hours digest, or collapsed into an earlier one).

CREATE TABLE alert_settings (
  user_id     bigint PRIMARY KEY,
  login       text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_subscriptions (
  user_id         bigint NOT NULL,
  login           text NOT NULL,
  installation_id bigint NOT NULL,
  repo_id         bigint NOT NULL,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, installation_id, repo_id),
  FOREIGN KEY (installation_id, repo_id) REFERENCES repos(installation_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_subscriptions_repo ON alert_subscriptions (installation_id, repo_id);

CREATE TABLE push_subscriptions (
  endpoint    text PRIMARY KEY,
  user_id     bigint NOT NULL,
  keys        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE alerts (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL,
  installation_id bigint NOT NULL,
  repo_id         bigint NOT NULL,
  run_id          text NOT NULL,
  unit_id         text,
  trigger         text NOT NULL,
  urgency         text NOT NULL,
  collapse_key    text NOT NULL,
  status          text NOT NULL,          -- sent | queued (digest) | dropped
  count           integer NOT NULL DEFAULT 1,
  detail          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX alerts_user ON alerts (user_id, created_at DESC);
CREATE INDEX alerts_collapse ON alerts (user_id, collapse_key, created_at DESC);
CREATE INDEX alerts_queued ON alerts (status) WHERE status = 'queued';
