export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  RATE_LIMITER: RateLimiter
  PUBLIC_BASE: string
  MAIL_FROM: string
  HOURLY_LIMIT?: string
  /** secret: `wrangler secret put RESEND_API_KEY` */
  RESEND_API_KEY?: string
  /** static assets (vendored rrweb-player), see wrangler.jsonc "assets" */
  ASSETS: Fetcher
}

export interface ProjectRow {
  id: string
  name: string
  public_key: string
  allowed_origins: string
  notify_emails: string
  key_prefix: string
  created_at: number
  /** 'each' | 'digest' */
  email_mode: string
  digest_tz: string | null
}

export interface ReportRow {
  id: string
  project_id: string
  seq: number
  title: string
  verdict_kind: string | null
  verdict_headline: string | null
  severity: string | null
  status: string
  page_url: string | null
  reporter: string | null
  request_ids: string | null
  created_at: number
  r2_prefix: string
  email_status: string
  scrubbed: number
  has_replay: number
  auto_snaps: number
  replay_dropped: number
  digested_at: number | null
  user_saw: string | null
}

export const DAY_MS = 86_400_000
export const RETENTION_MS = 90 * DAY_MS
