-- The project map a run pushed (runs/<run>/map/events.jsonl), replayed and
-- checked with the skill's own code. A log that fails keeps the last good map.
ALTER TABLE runs ADD COLUMN map_sha text;
ALTER TABLE runs ADD COLUMN map jsonb;
ALTER TABLE runs ADD COLUMN map_error text;
