-- Removing a repo deletes its alerts by (installation_id, repo_id); without an index that reads every alert.
CREATE INDEX IF NOT EXISTS alerts_repo ON alerts (installation_id, repo_id);
