// Second-deployment knobs: DIGEST_CRON, TZ, EMAIL_ENABLED.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, ReportRow } from '../src/env'
import { resetAccessCache } from '../src/access'
import worker from '../src/index'
import { formatLocal, tzOf, zoneLabel } from '../src/util'
import { ACCESS_VARS, accessHeaders, BASE, call, certsResponse, form, ingestRequest, payload, seed, testEnv } from './helpers'

let resend: unknown[] = []
beforeEach(async () => {
  resetAccessCache()
  await seed()
  resend = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const certs = await certsResponse(url)
    if (certs) return certs
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`)
    resend.push(JSON.parse(String(init?.body)))
    return new Response('{"id":"e"}', { status: 200 })
  })
})
afterEach(() => vi.restoreAllMocks())

const row = (id: string) => env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>()
async function cron(expr: string, e: Env) {
  const ctx = createExecutionContext()
  await worker.scheduled(createScheduledController({ cron: expr }), e, ctx)
  await waitOnExecutionContext(ctx)
}
async function submit(e: Env, over: Parameters<typeof payload>[0] = {}): Promise<string> {
  const res = await call(ingestRequest(form(payload({ severity: 'minor', ...over }))), e)
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

describe('DIGEST_CRON', () => {
  it('routes the configured expression to the digest and anything else to maintenance', async () => {
    const e = testEnv({ DIGEST_CRON: '5 4 * * *' })
    const id = await submit(e)
    await cron('0 6,18 * * *', e) // the default expression is no longer the digest
    expect(resend).toHaveLength(0)
    expect((await row(id))?.digested_at).toBeNull()
    await cron('5 4 * * *', e)
    expect(resend).toHaveLength(1)
    expect((await row(id))?.digested_at).not.toBeNull()
  })

  it('falls back to the default expression when unset', async () => {
    const e = testEnv()
    await submit(e)
    await cron('0 6,18 * * *', e)
    expect(resend).toHaveLength(1)
  })
})

describe('timezone helpers', () => {
  it('formatLocal renders wall-clock time in the zone', () => {
    const ms = Date.UTC(2026, 0, 15, 12, 0)
    expect(formatLocal(ms, 'Asia/Amman')).toBe('2026-01-15 15:00')
    expect(formatLocal(ms, 'Europe/London')).toBe('2026-01-15 12:00')
    expect(formatLocal(Date.UTC(2026, 6, 15, 12, 0), 'Europe/London')).toBe('2026-07-15 13:00')
  })
  it('zoneLabel uses the last segment', () => {
    expect(zoneLabel('Asia/Amman')).toBe('Amman')
    expect(zoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(zoneLabel('UTC')).toBe('UTC')
  })
  it('tzOf defaults and rejects invalid zones', () => {
    expect(tzOf({})).toBe('Asia/Amman')
    expect(tzOf({ TZ: 'Europe/London' })).toBe('Europe/London')
    expect(tzOf({ TZ: 'Not/AZone' })).toBe('Asia/Amman')
  })
  it('list and report pages use TZ', async () => {
    const e = testEnv({ ...ACCESS_VARS, TZ: 'Europe/London' })
    const id = await submit(e)
    const get = async (p: string) => call(new Request(`${BASE}${p}`, { headers: await accessHeaders() }), e)
    const list = await (await get('/')).text()
    expect(list).toContain('(Europe/London)')
    expect(list).not.toContain('Amman')
    const page = await (await get(`/r/${id}`)).text()
    expect(page).toContain('(London)')
    expect(page).not.toContain('(Amman)')
  })
})

describe('EMAIL_ENABLED=0', () => {
  const off = () => testEnv({ EMAIL_ENABLED: '0' })

  it('a blocker is marked skipped, nothing is sent, and the retry query ignores it', async () => {
    const e = off()
    const id = await submit(e, { severity: 'blocker' })
    expect(resend).toHaveLength(0)
    expect((await row(id))?.email_status).toBe('skipped')
    await cron('17 3 * * *', e)
    expect(resend).toHaveLength(0)
    expect((await row(id))?.email_status).toBe('skipped')
  })

  it('the digest marks rows digested without sending', async () => {
    const e = off()
    const id = await submit(e)
    expect((await row(id))?.email_status).toBe('digest')
    await cron('0 6,18 * * *', e)
    expect(resend).toHaveLength(0)
    const r = await row(id)
    expect(r?.digested_at).not.toBeNull()
    expect(r?.email_status).toBe('skipped')
    // re-enabled later: nothing old piles up into a digest
    await cron('0 6,18 * * *', testEnv())
    expect(resend).toHaveLength(0)
  })

  it('enabled with no RESEND_API_KEY still fails the blocker email', async () => {
    const e = testEnv({ RESEND_API_KEY: undefined })
    const id = await submit(e, { severity: 'blocker' })
    expect((await row(id))?.email_status).toBe('failed')
  })
})
