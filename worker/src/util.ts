import { AUTO_PART } from './limits'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape any value for HTML text or a double/single-quoted attribute. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Path (+ search) of an absolute or relative URL; the input unchanged if unparsable. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url, 'http://x')
    return u.pathname + u.search
  } catch {
    return url
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

/** "2026-10-09 14:05" in Asia/Amman (the digest and list page timezone). */
export function formatAmman(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`
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
