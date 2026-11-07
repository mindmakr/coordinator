-- c14: installations removed for good. GitHub never reuses an installation id, so a late
-- "created" (or any event) for one of these is refused instead of bringing it back.
CREATE TABLE uninstalled (
  id  bigint PRIMARY KEY,
  at  timestamptz NOT NULL DEFAULT now()
);

-- c14: a forced re-read of the repo is under way (its runs' blob shas were forgotten). Every
-- sync carries it on, even when the branch tip has not moved, until one leaves nothing for later.
ALTER TABLE repos ADD COLUMN reread boolean NOT NULL DEFAULT false;
