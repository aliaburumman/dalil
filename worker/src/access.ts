// Cloudflare Access JWT verification (RS256) with no external deps.
// Fails closed: any missing config, bad token or JWKS error returns null.
import type { Env } from './env'

type Jwk = JsonWebKey & { kid?: string }
const JWKS_TTL_MS = 60 * 60 * 1000
const REFETCH_MIN_MS = 60 * 1000
const SKEW_S = 60

let cache: { domain: string; keys: Jwk[]; at: number } | null = null

/** Test hook: drop the module-scope JWKS cache. */
export function resetAccessCache(): void {
  cache = null
}

async function loadKeys(domain: string, force: boolean): Promise<Jwk[]> {
  const now = Date.now()
  if (cache && cache.domain === domain && !force && now - cache.at < JWKS_TTL_MS) return cache.keys
  if (cache && cache.domain === domain && force && now - cache.at < REFETCH_MIN_MS) return cache.keys
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`certs ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  if (!Array.isArray(body.keys)) throw new Error('certs: no keys')
  cache = { domain, keys: body.keys, at: now }
  return body.keys
}

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

function parseJson(s: string): Record<string, unknown> {
  const v = JSON.parse(new TextDecoder().decode(b64urlBytes(s)))
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object')
  return v as Record<string, unknown>
}

function tokenFrom(req: Request): string | null {
  const h = req.headers.get('cf-access-jwt-assertion')
  if (h) return h
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') ?? '')
  return m ? m[1]! : null
}

export async function verifyAccess(req: Request, env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'DEV_NO_AUTH'>): Promise<{ email: string } | null> {
  if (env.DEV_NO_AUTH === '1') return { email: 'dev@local' }
  const domain = (env.ACCESS_TEAM_DOMAIN ?? '').trim()
  const aud = (env.ACCESS_AUD ?? '').trim()
  if (!domain || !aud) return null
  try {
    const token = tokenFrom(req)
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = parseJson(parts[0]!)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null

    let jwk = (await loadKeys(domain, false)).find((k) => k.kid === header.kid)
    if (!jwk) jwk = (await loadKeys(domain, true)).find((k) => k.kid === header.kid)
    if (!jwk) return null

    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null

    const p = parseJson(parts[1]!)
    const auds = Array.isArray(p.aud) ? p.aud : [p.aud]
    if (!auds.includes(aud)) return null
    if (p.iss !== `https://${domain}`) return null
    const now = Math.floor(Date.now() / 1000)
    if (typeof p.exp !== 'number' || p.exp <= now) return null
    if (p.nbf !== undefined && (typeof p.nbf !== 'number' || p.nbf > now + SKEW_S)) return null
    if (p.iat !== undefined && (typeof p.iat !== 'number' || p.iat > now + SKEW_S)) return null
    if (typeof p.email !== 'string' || !p.email) return null
    return { email: p.email }
  } catch {
    return null
  }
}

export const ACCESS_DENIED = 'Protected: configure Cloudflare Access (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)'

export function accessDenied(): Response {
  return new Response(ACCESS_DENIED, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
