import { AUTO_PART } from './limits'
import { esc, pathOf, truncate } from '../../shared/text'

export { esc, pathOf, truncate }


export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

/** R2 key suffix for a part. Auto snapshots are always stored as auto_N.jpg (content type is in metadata). */
export function partKey(part: string): string {
  return AUTO_PART.test(part) ? `${part}.jpg` : part
}

/** Default display timezone; override with the TZ var. */
export const DEFAULT_TZ = 'Asia/Amman'

/** "2026-10-09 14:05" in the given IANA timezone (the digest and list page timezone). */
export function formatLocal(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
}

/** "Amman" from "Asia/Amman"; "Buenos Aires" from "America/Argentina/Buenos_Aires". */
export function zoneLabel(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ')
}

/** Configured display timezone, falling back to the default when unset or invalid. */
export function tzOf(env: { TZ?: string }): string {
  const tz = env.TZ?.trim()
  if (!tz) return DEFAULT_TZ
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_TZ
  }
}

/** userName + tenant out of the stored reporter JSON (ReportContext). */
export function reporterOf(raw: string | null | undefined): { name: string; tenant: string } {
  try {
    const c = JSON.parse(raw ?? '{}') as { userName?: unknown; email?: unknown; tenant?: unknown }
    const s = (v: unknown) => (typeof v === 'string' ? v : '')
    return { name: s(c.userName) || s(c.email), tenant: s(c.tenant) }
  } catch {
    return { name: '', tenant: '' }
  }
}

/**
 * Link to a report's evidence page. When the report has a replay, `?play=failure` makes the player
 * start a few seconds before the first failure. Plain url otherwise.
 */
export function evidenceUrl(base: string, id: string, hasReplay: boolean | number | null | undefined): string {
  return `${base}/r/${id}${hasReplay ? '?play=failure' : ''}`
}
