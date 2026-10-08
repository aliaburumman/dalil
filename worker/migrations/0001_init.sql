-- Dalil collector schema v1 (docs/design.md, "D1 schema (v1)").
-- Timestamps are epoch milliseconds (INTEGER).

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,           -- "space", "kings"
  name            TEXT NOT NULL,
  public_key      TEXT NOT NULL,              -- sent by the widget as X-Dalil-Key (public by nature)
  allowed_origins TEXT NOT NULL DEFAULT '[]', -- JSON array of exact origins, e.g. ["https://portal.example.com"]
  notify_emails   TEXT NOT NULL DEFAULT '[]', -- JSON array of addresses
  key_prefix      TEXT NOT NULL,              -- "SPACE" -> refs SPACE-1, SPACE-2…
  created_at      INTEGER NOT NULL
);

CREATE TABLE reports (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  seq              INTEGER NOT NULL,
  title            TEXT NOT NULL,
  verdict_kind     TEXT,
  verdict_headline TEXT,
  severity         TEXT,
  status           TEXT NOT NULL DEFAULT 'new',     -- new | seen | fixed | wontfix
  page_url         TEXT,
  reporter         TEXT,                            -- JSON (ReportContext)
  request_ids      TEXT,                            -- JSON array (failed requests' X-Request-Id)
  created_at       INTEGER NOT NULL,
  r2_prefix        TEXT NOT NULL,                   -- reports/{project}/{id}/
  email_status     TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  scrubbed         INTEGER NOT NULL DEFAULT 0,      -- 1 = server-side scrub found a secret
  UNIQUE (project_id, seq)
);

CREATE INDEX reports_created_at ON reports (created_at);

-- Accepted ingest attempts, for the hourly per ip+project cap (Workers Rate Limiting
-- cannot express a 1-hour window). ip_hash is SHA-256(ip), never the raw address.
-- Pruned by the daily cron.
CREATE TABLE ingest_hits (
  project_id TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX ingest_hits_lookup ON ingest_hits (project_id, ip_hash, at);
