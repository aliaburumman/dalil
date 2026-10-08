-- v0.2: session replay + automatic failure snapshots.
ALTER TABLE reports ADD COLUMN has_replay INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN auto_snaps INTEGER NOT NULL DEFAULT 0;
-- 1 = a replay was sent but dropped (hourly replay cap)
ALTER TABLE reports ADD COLUMN replay_dropped INTEGER NOT NULL DEFAULT 0;

-- Reports that carried a replay, for the per ip+project hourly replay cap (10/hour).
-- ip_hash is SHA-256(ip). Pruned by the daily cron.
CREATE TABLE replay_hits (
  project_id TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX replay_hits_lookup ON replay_hits (project_id, ip_hash, at);
