-- The GitHub trail: which issues and PRs each unit links, what GitHub said
-- about them (merged, closed, checks), and the tracker comment and board card
-- the service keeps for each (unit, issue or PR).

ALTER TABLE repos ADD COLUMN private boolean;
ALTER TABLE repos ADD COLUMN config jsonb;

CREATE TABLE unit_refs (
  installation_id bigint NOT NULL,
  repo_id         bigint NOT NULL,
  run_id          text NOT NULL,
  unit_id         text NOT NULL,
  ref_key         text NOT NULL,
  PRIMARY KEY (installation_id, repo_id, run_id, unit_id, ref_key),
  FOREIGN KEY (installation_id, repo_id) REFERENCES repos(installation_id, id) ON DELETE CASCADE
);
CREATE INDEX unit_refs_key ON unit_refs (installation_id, ref_key);

CREATE TABLE gh_events (
  installation_id bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id              text NOT NULL,
  ref_key         text NOT NULL,
  kind            text NOT NULL,
  at              timestamptz NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (installation_id, id)
);
CREATE INDEX gh_events_key ON gh_events (installation_id, ref_key, at);

CREATE TABLE trackers (
  installation_id bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  ref_key         text NOT NULL,
  run_id          text NOT NULL,
  unit_id         text NOT NULL,
  comment_id      bigint,
  body_sha        text,
  board_sha       text,
  PRIMARY KEY (installation_id, ref_key, run_id, unit_id)
);
