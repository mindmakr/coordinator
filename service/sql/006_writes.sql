-- Comment commands (c12): each comment is handled once. A row is claimed before
-- the command runs; a failure that GitHub should redeliver removes the claim.
CREATE TABLE comment_commands (
  installation_id bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  comment_id      bigint NOT NULL,
  status          text NOT NULL DEFAULT 'claimed',
  at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, comment_id)
);
