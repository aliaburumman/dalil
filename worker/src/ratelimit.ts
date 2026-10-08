// Two layers, because Workers Rate Limiting only supports a 10s or 60s period:
//  1. RATE_LIMITER binding: 20 per 60s per ip+project (burst guard, cheap, per-location
//     and eventually consistent by design).
//  2. D1 count: HOURLY_LIMIT (default 20) accepted attempts per ip+project in the last
//     hour — the design's "20 reports per hour". The IP is stored only as SHA-256.
import type { Env } from './env'
import { sha256Hex } from './util'

const HOUR_MS = 3_600_000

/** Returns an error message when limited, or null and records the hit. */
export async function checkRateLimits(env: Env, projectId: string, ip: string): Promise<string | null> {
  const burst = await env.RATE_LIMITER.limit({ key: `${projectId}:${ip}` })
  if (!burst.success) return 'rate limited, try again in a minute'

  const limit = Number(env.HOURLY_LIMIT ?? '20') || 20
  const ipHash = await sha256Hex(ip)
  const now = Date.now()
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_hits WHERE project_id = ? AND ip_hash = ? AND at > ?')
    .bind(projectId, ipHash, now - HOUR_MS)
    .first<{ n: number }>()
  if ((row?.n ?? 0) >= limit) return 'hourly report limit reached, try again later'
  await env.DB.prepare('INSERT INTO ingest_hits (project_id, ip_hash, at) VALUES (?, ?, ?)').bind(projectId, ipHash, now).run()
  return null
}

export const REPLAY_HOURLY_LIMIT = 10

/**
 * Per ip+project cap on reports that carry a replay. Returns true when the replay may be
 * kept (and records it), false when the cap is reached (caller drops the replay only).
 */
export async function takeReplaySlot(env: Env, projectId: string, ip: string): Promise<boolean> {
  const ipHash = await sha256Hex(ip)
  const now = Date.now()
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM replay_hits WHERE project_id = ? AND ip_hash = ? AND at > ?')
    .bind(projectId, ipHash, now - HOUR_MS)
    .first<{ n: number }>()
  if ((row?.n ?? 0) >= REPLAY_HOURLY_LIMIT) return false
  await env.DB.prepare('INSERT INTO replay_hits (project_id, ip_hash, at) VALUES (?, ?, ?)').bind(projectId, ipHash, now).run()
  return true
}
