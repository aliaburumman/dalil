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
  /** Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com (empty = list/status locked) */
  ACCESS_TEAM_DOMAIN?: string
  /** Cloudflare Access application AUD tag */
  ACCESS_AUD?: string
  /** IANA timezone for dates on the list page and in the digest (default Asia/Amman) */
  TZ?: string
  /** Cron expression that triggers the digest; must equal one of wrangler "triggers.crons" (default "0 6,18 * * *") */
  DIGEST_CRON?: string
  /** "0" disables all outbound email (default "1") */
  EMAIL_ENABLED?: string
  /** DEV ONLY: "1" skips Access verification. Set only via `wrangler dev --var DEV_NO_AUTH:1`; never in wrangler.jsonc (a test enforces it). */
  DEV_NO_AUTH?: string
  /** secret: Teams Workflows webhook URL; when set, each new report posts an Adaptive Card */
  NOTIFY_WEBHOOK_URL?: string
  /** Azure DevOps organisation, project and PAT (secret) enable the "Create work item" button */
  ADO_ORG?: string
  ADO_PROJECT?: string
  ADO_PAT?: string
  /** default 'Bug' */
  ADO_WORK_ITEM_TYPE?: string
  /** field that receives the repro steps (default 'Microsoft.VSTS.TCM.ReproSteps'; Basic process: 'System.Description') */
  ADO_BODY_FIELD?: string
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
  /** null = none, 'pending:<epoch ms>' = being created (stale after 2 min), else the Azure DevOps work item URL */
  workitem_url: string | null
}

export const DAY_MS = 86_400_000
export const RETENTION_MS = 90 * DAY_MS
