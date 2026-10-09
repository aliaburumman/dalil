import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccessCache } from '../src/access'
import { ACCESS_VARS, AUD, BASE, call, certsResponse, seed, signJwt, TEAM, testEnv } from './helpers'

beforeEach(async () => {
  resetAccessCache()
  await seed()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const certs = await certsResponse(url)
    if (certs) return certs
    throw new Error(`unexpected fetch ${url}`)
  })
})
afterEach(() => vi.restoreAllMocks())

const list = (headers: Record<string, string>, vars = ACCESS_VARS) => call(new Request(`${BASE}/`, { headers }), testEnv(vars))
const jwt = async (claims: Record<string, unknown> = {}, kid?: string) => ({ 'cf-access-jwt-assertion': await signJwt(claims, kid) })
const now = () => Math.floor(Date.now() / 1000)

describe('Cloudflare Access verification', () => {
  it('accepts a valid token and shows the email', async () => {
    const res = await list(await jwt({ email: 'boss@example.com' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Signed in as boss@example.com')
  })

  it('accepts the CF_Authorization cookie as fallback', async () => {
    const res = await list({ cookie: `a=b; CF_Authorization=${await signJwt()}` })
    expect(res.status).toBe(200)
  })

  it('accepts aud as a plain string', async () => {
    expect((await list(await jwt({ aud: AUD }))).status).toBe(200)
  })

  it.each([
    ['missing header', async () => ({})],
    ['forged header', async () => ({ 'cf-access-jwt-assertion': 'x' })],
    ['forged three-part header', async () => ({ 'cf-access-jwt-assertion': 'x.y.z' })],
    ['wrong aud', () => jwt({ aud: ['other'] })],
    ['wrong iss', () => jwt({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', () => jwt({ exp: now() - 10 })],
    ['not yet valid', () => jwt({ nbf: now() + 600 })],
    ['unknown kid', () => jwt({}, 'nope')],
    ['no email', () => jwt({ email: undefined })],
  ])('403 on %s', async (_n, mk) => {
    const res = await list(await mk())
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('set ACCESS_TEAM_DOMAIN and ACCESS_AUD')
  })

  it('403 on a tampered payload', async () => {
    const [h, , s] = (await signJwt()).split('.')
    const evil = btoa(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: 'evil@example.com', exp: now() + 999 })).replace(/=+$/, '')
    expect((await list({ 'cf-access-jwt-assertion': `${h}.${evil}.${s}` })).status).toBe(403)
  })

  it('fails closed when the vars are empty, even with a valid token', async () => {
    const h = await jwt()
    expect((await list(h, {})).status).toBe(403)
    expect((await list(h, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '' })).status).toBe(403)
    expect((await list(h, { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD })).status).toBe(403)
  })

  it('403 when the certs fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    expect((await list(await jwt())).status).toBe(403)
  })

  it('POST /r/:id/status requires a valid token', async () => {
    const body = () => new URLSearchParams({ status: 'fixed' })
    const post = async (headers: Record<string, string>) =>
      call(new Request(`${BASE}/r/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/status`, { method: 'POST', body: body(), headers }), testEnv(ACCESS_VARS))
    expect((await post({})).status).toBe(403)
    expect((await post({ 'cf-access-jwt-assertion': 'x' })).status).toBe(403)
    expect((await post(await jwt())).status).toBe(404) // authenticated, report unknown
  })

  it('DEV_NO_AUTH=1 skips verification, and the production config never sets it', async () => {
    const dev = await call(new Request(`${BASE}/`), testEnv({ ...ACCESS_VARS, DEV_NO_AUTH: '1' }))
    expect(dev.status).toBe(200)
    const prod = await call(new Request(`${BASE}/`), testEnv(ACCESS_VARS))
    expect(prod.status).toBe(403)
    const cfg: string = (await import('../wrangler.jsonc?raw')).default
    expect(cfg).not.toContain('DEV_NO_AUTH')
  })
})
