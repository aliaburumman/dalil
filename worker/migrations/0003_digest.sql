-- 12-hour bug digest + reports list page.
-- email_mode: 'each' = one email per report (old behaviour); 'digest' = batched, except blockers.
ALTER TABLE projects ADD COLUMN email_mode TEXT NOT NULL DEFAULT 'digest';
-- Informational only: the digest is rendered in Asia/Amman today.
ALTER TABLE projects ADD COLUMN digest_tz TEXT DEFAULT 'Asia/Amman';

-- NULL = not yet included in a digest. email_status gains the value 'digest' (queued for the digest).
ALTER TABLE reports ADD COLUMN digested_at INTEGER;
-- verdict.userSaw, copied at ingest so the digest needs no R2 reads.
ALTER TABLE reports ADD COLUMN user_saw TEXT;

-- Every report that exists today was already emailed one by one; do not resend them in the first digest.
UPDATE reports SET digested_at = created_at;

CREATE INDEX reports_undigested ON reports (project_id, created_at) WHERE digested_at IS NULL;
