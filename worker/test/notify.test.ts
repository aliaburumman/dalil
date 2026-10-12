import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, call, form, ingestRequest, payload, seed, testEnv } from './helpers'

const HOOK = 'https://prod-1.westeurope.logic.azure.com/workflows/abc?sig=x'
let hook: ReturnType<typeof vi.fn<(init?: RequestInit) => Response>>

beforeEach(async () => {
  await seed()
  hook = vi.fn<(init?: RequestInit) => Response>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === HOOK) return hook(init)
    if (url === 'https://api.resend.com/emails') return Response.json({ id: 'x' })
    throw new Error(`unexpected fetch ${url}`)
  })
})
afterEach(() => vi.restoreAllMocks())

const ingest = (vars = {}) => call(ingestRequest(form(payload())), testEnv({ NOTIFY_WEBHOOK_URL: HOOK, ...vars }))

describe('Teams notification', () => {
  it('posts one Adaptive Card with the triage url', async () => {
    hook.mockReturnValue(new Response('', { status: 202 }))
    const res = await ingest()
    expect(res.status).toBe(201)
    const { url } = (await res.json()) as { url: string }
    expect(hook).toHaveBeenCalledTimes(1)
    const init = hook.mock.calls[0]![0] as RequestInit
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.type).toBe('message')
    const att = body.attachments[0]
    expect(att.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(att.content.type).toBe('AdaptiveCard')
    expect(att.content.version).toBe('1.4')
    expect(att.content.body[0]).toMatchObject({ type: 'TextBlock', weight: 'Bolder', wrap: true })
    expect(att.content.body[0].text).toContain("can't save payment")
    expect(att.content.body[1].text).toContain('Blocker')
    expect(att.content.body[1].text).toContain('Backend error')
    expect(att.content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open report', url }])
    expect(url.startsWith(BASE) || url.includes('/r/')).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/<[a-z]/)
  })

  it('still 201 when the webhook answers 500', async () => {
    hook.mockReturnValue(new Response('no', { status: 500 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await ingest()).status).toBe(201)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('still 201 when the webhook throws', async () => {
    hook.mockImplementation(() => {
      throw new Error('boom')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await ingest()).status).toBe(201)
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('does not call out when no URL is set', async () => {
    expect((await ingest({ NOTIFY_WEBHOOK_URL: undefined })).status).toBe(201)
    expect(hook).not.toHaveBeenCalled()
  })

  it('works with EMAIL_ENABLED=0', async () => {
    hook.mockReturnValue(new Response('', { status: 200 }))
    expect((await ingest({ EMAIL_ENABLED: '0' })).status).toBe(201)
    expect(hook).toHaveBeenCalledTimes(1)
  })
})
