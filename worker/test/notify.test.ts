import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, call, form, ingestRequest, payload, seed, testEnv } from './helpers'

async function gz(text: string) {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}

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

  it('links carry ?play=failure (card url and share) only when the report has a replay', async () => {
    hook.mockReturnValue(new Response('', { status: 202 }))
    const plain = (await (await ingest()).json()) as { url: string; share: { html: string; text: string } }
    expect(hook.mock.calls[0]![0]!.body as string).not.toContain('play=failure')
    expect(plain.share.text).not.toContain('play=failure')

    hook.mockClear()
    const p = payload({ v: 2, replay: { part: 'replay', durationMs: 5000, events: 1, bytes: 1, rrweb: '2.0.0' } } as never)
    const images = { image_0: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]), type: 'image/jpeg' }, replay: { bytes: await gz('[{"type":4,"timestamp":1,"data":{}}]'), type: 'application/gzip' } }
    const res = await call(ingestRequest(form(p, images)), testEnv({ NOTIFY_WEBHOOK_URL: HOOK }))
    expect(res.status).toBe(201)
    const withReplay = (await res.json()) as { url: string; share: { html: string; text: string } }
    const card = JSON.parse(hook.mock.calls[0]![0]!.body as string)
    expect(card.attachments[0].content.actions[0].url).toBe(`${withReplay.url}?play=failure`)
    expect(withReplay.share.text).toContain(`Full evidence: ${withReplay.url}?play=failure`)
    expect(withReplay.share.html).toContain(`href="${withReplay.url}?play=failure"`)
  })
})
