-- Retention deletes run on the write path (every webhook delivery, GitHub event, comment command
-- and alert removes rows past their keep time). Each filters on its timestamp alone, so each gets
-- an index on it, as audit (audit_at) and sessions (sessions_expires) have had since 001.
CREATE INDEX IF NOT EXISTS deliveries_at ON deliveries (at);
CREATE INDEX IF NOT EXISTS gh_events_at ON gh_events (at);
CREATE INDEX IF NOT EXISTS comment_commands_at ON comment_commands (at);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at);
