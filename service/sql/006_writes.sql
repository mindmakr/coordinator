-- Comment commands (c12): each comment is handled once. A row is claimed before
-- the command runs; a failure that GitHub should redeliver removes the claim.
CREATE TABLE comment_commands (
  installation_id bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  comment_id      bigint NOT NULL,
  status          text NOT NULL DEFAULT 'claimed',
  at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, comment_id)
);

-- c11 follow-up: trail_seq values come from one sequence, so a run dropped and re-created
-- (dropRunsExcept, then putRun) never gets back a value a refresh read before (no ABA).
CREATE SEQUENCE trail_seq_global;
-- Start it past every value 005's per-run counters already hold, so the first nextval on a
-- database upgraded from 005 is above each run's current trail_seq (a fresh database: 1).
SELECT setval('trail_seq_global', GREATEST((SELECT max(trail_seq) FROM runs), 0) + 1, false);
