import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccessCache } from '../src/access'
import { ROUTES } from '../src/routes'
import { ACCESS_VARS, accessHeaders, AUD, BASE, call, certsResponse, form, ingestRequest, ORIGIN, payload, seed, signJwt, TEAM, testEnv } from './helpers'

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

  it('DEV_NO_AUTH=1 skips verification only on localhost, and the production config never sets it', async () => {
    const dev = await call(new Request('http://localhost:8799/'), testEnv({ ...ACCESS_VARS, DEV_NO_AUTH: '1' }))
    expect(dev.status).toBe(200)
    const strayVar = await call(new Request(`${BASE}/`), testEnv({ ...ACCESS_VARS, DEV_NO_AUTH: '1' }))
    expect(strayVar.status).toBe(403)
    const prod = await call(new Request(`${BASE}/`), testEnv(ACCESS_VARS))
    expect(prod.status).toBe(403)
    const cfg: string = (await import('../wrangler.jsonc?raw')).default
    expect(cfg).not.toContain('DEV_NO_AUTH')
  })
})

describe('deny by default', () => {
  const authed = async (method: string, path: string, init: RequestInit = {}, base = BASE) =>
    call(new Request(`${base}${path}`, { method, ...init, headers: { ...(await accessHeaders()), ...(init.headers as Record<string, string>) } }), testEnv(ACCESS_VARS))
  const anon = (method: string, path: string, init: RequestInit = {}) => call(new Request(`${BASE}${path}`, { method, ...init }), testEnv(ACCESS_VARS))
  const seedReport = async () => {
    const res = await call(ingestRequest(form(payload({ severity: 'minor' }))))
    return ((await res.json()) as { id: string }).id
  }

  it('every guarded route is 403 without a token and not 403 with one', async () => {
    const id = await seedReport()
    const concrete: [string, string][] = [
      ['GET', '/'],
      ['GET', '/p/space'],
      ['GET', `/r/${id}`],
      ['GET', `/r/${id}/img/image_0`],
      ['GET', `/r/${id}/auto/0`],
      ['GET', `/r/${id}/replay`],
      ['POST', `/r/${id}/status`],
    ]
    const guarded = ROUTES.filter((r) => !r.public)
    expect(guarded.length).toBeGreaterThan(0)
    for (const r of guarded) {
      const hits = concrete.filter(([m, p]) => m === r.method && r.pattern.test(p))
      expect(hits, `a concrete path for ${r.method} ${r.pattern}`).toHaveLength(1)
    }
    for (const [method, path] of concrete) {
      const init = method === 'POST' ? { body: new URLSearchParams({ status: 'seen' }) } : {}
      const denied = await anon(method, path, init)
      expect(denied.status, `${method} ${path} unauthenticated`).toBe(403)
      expect((await authed(method, path, init)).status, `${method} ${path} authenticated`).not.toBe(403)
    }
  })

  it('report page offers escaped copy-title and copy-repro buttons', async () => {
    const res = await call(ingestRequest(form(payload({ title: '<script>alert(1)</script> x' }))))
    const { id } = (await res.json()) as { id: string }
    const page = await authed('GET', `/r/${id}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('data-copy-rich="share-html"')
    expect(html).toContain('data-copy="share-title"')
    expect(html).toContain('<template id="share-html"><p><b>SPACE-1: &lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)')
  })

  it('unknown paths and methods are 403 unauthenticated and 404 authenticated', async () => {
    for (const path of ['/x', '/r', '/r/a/b/c', '/admin', '/v1/other']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect((await anon(method, path)).status, `${method} ${path}`).toBe(403)
      }
      expect((await authed('GET', path)).status, `authed GET ${path}`).toBe(404)
    }
    expect((await anon('PUT', '/r/abc/status')).status).toBe(403)
    expect((await anon('GET', '/assets/other.js')).status).toBe(403)
  })

  it('public routes need no token', async () => {
    const pre = await anon('OPTIONS', '/v1/reports', { headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-dalil-key,x-dalil-project' } })
    expect(pre.status).toBe(204)
    expect((await anon('GET', '/assets/rrweb-player.9.9.9.js')).status).not.toBe(403)
    const put = await anon('PUT', '/v1/reports')
    expect(put.status).toBe(405)
    expect(put.headers.get('allow')).toBe('POST, OPTIONS')
  })

  it('DEV_NO_AUTH bypasses only on localhost, for guarded routes of every kind', async () => {
    const env = testEnv({ ...ACCESS_VARS, DEV_NO_AUTH: '1' })
    expect((await call(new Request(`${BASE}/anything`), env)).status).toBe(403)
    expect((await call(new Request(`${BASE}/`), env)).status).toBe(403)
    expect((await call(new Request('http://localhost:8799/'), env)).status).toBe(200)
    expect((await call(new Request('http://localhost:8799/anything'), env)).status).toBe(404)
  })

  it('POST /r/:id/status rejects a foreign Origin and accepts its own', async () => {
    const id = await seedReport()
    const post = (origin?: string) =>
      authed('POST', `/r/${id}/status`, { body: new URLSearchParams({ status: 'fixed' }), headers: origin ? { origin } : {} })
    expect((await post('https://evil.test')).status).toBe(403)
    expect((await post(new URL(BASE).origin)).status).toBe(303)
    expect((await post()).status).toBe(303) // missing Origin allowed
  })
})
