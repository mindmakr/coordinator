-- A run whose last trail refresh held a comment back (the per-installation write cap).
-- Every later sync retries it, even when the state branch has not moved.
ALTER TABLE runs ADD COLUMN trail_pending boolean NOT NULL DEFAULT false;
