-- A counter bumped every time a refresh marks a run's trail as owed. A retrail clears trail_pending
-- only if the counter still holds the value it read before it started, so a deferral recorded
-- meanwhile (another refresh, another process) is never overwritten by a clean finish.
ALTER TABLE runs ADD COLUMN trail_seq bigint NOT NULL DEFAULT 0;
