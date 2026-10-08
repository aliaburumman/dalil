import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests, init } from './recorder'
import { __resetSubmitForTests, DalilSubmitError, flushPending, submit } from './submit'
import type { ReportPayload } from './types'

const payload = { v: 1, project: 'space', title: 'broken' } as unknown as ReportPayload
const cfg = { project: 'space', publicKey: 'pk_1', endpoint: 'https://dalil.example.com/v1/reports' }

let mode: 'ok' | 'down' | 'reject'
let seen: { url: string; init: RequestInit }[]

beforeEach(() => {
  seen = []
  mode = 'ok'
  window.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! })
    if (mode === 'down') throw new TypeError('Failed to fetch')
    if (mode === 'reject') return new Response(JSON.stringify({ error: 'bad key' }), { status: 403 })
    return new Response(JSON.stringify({ id: 'r1', ref: 'SPACE-1', url: 'https://x/r1' }), { status: 201 })
  }) as typeof fetch
  init(cfg)
})

afterEach(async () => {
  mode = 'ok'
  await flushPending()
  __resetForTests()
})

describe('submit', () => {
  it('posts multipart with the key and is not recorded', async () => {
    const res = await submit(payload, [{ part: 'image_0', name: 's.png', blob: new Blob(['x'], { type: 'image/png' }) }])
    expect(res.ref).toBe('SPACE-1')
    const call = seen.at(-1)!
    expect(call.url).toBe(`${cfg.endpoint}?project=space`)
    const h = call.init.headers as Record<string, string>
    expect(h['X-Dalil-Key']).toBe('pk_1')
    expect(h['X-Dalil-Project']).toBe('space')
    const fd = call.init.body as FormData
    expect(fd.get('report')).toBeTruthy()
    expect(fd.get('image_0')).toBeTruthy()
  })

  it('does not duplicate an existing project query param', async () => {
    __resetForTests()
    init({ ...cfg, endpoint: `${cfg.endpoint}?project=space` })
    await submit(payload, [])
    expect(seen.at(-1)!.url).toBe(`${cfg.endpoint}?project=space`)
  })

  it('throws rejected on non-2xx', async () => {
    mode = 'reject'
    await expect(submit(payload, [])).rejects.toMatchObject({ code: 'rejected', status: 403, message: 'bad key' })
  })

  it('queues on network failure while offline and flushPending resends', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mode = 'down'
    const err = await submit(payload, []).catch((e) => e)
    expect(err).toBeInstanceOf(DalilSubmitError)
    expect(err.code).toBe('queued')
    online.mockRestore()
    expect(await flushPending()).toBeNull() // still down: kept
    mode = 'ok'
    const r = await flushPending()
    expect(r?.ref).toBe('SPACE-1')
    expect(await flushPending()).toBeNull() // gone
  })

  it('throws save_failed (not queued) when IndexedDB is unavailable', async () => {
    mode = 'down'
    vi.stubGlobal('indexedDB', undefined)
    try {
      const err = await submit(payload, []).catch((e) => e)
      expect(err).toBeInstanceOf(DalilSubmitError)
      expect(err.code).toBe('save_failed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops pending reports older than 24 h', async () => {
    mode = 'down'
    await submit(payload, []).catch(() => {})
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 3600_000)
    mode = 'ok'
    const before = seen.length
    expect(await flushPending()).toBeNull()
    expect(seen.length).toBe(before)
    spy.mockRestore()
  })

  describe('failure reasons', () => {
    let errSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => {
      errSpy.mockRestore()
      vi.restoreAllMocks()
    })

    it('build error -> build_failed and nothing stored', async () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const err = await submit(circular as unknown as ReportPayload, []).catch((e) => e)
      expect(err.code).toBe('build_failed')
      mode = 'ok'
      const before = seen.length
      expect(await flushPending()).toBeNull()
      expect(seen.length).toBe(before)
    })

    it('fetch rejects while online -> unreachable, stored, console.error', async () => {
      mode = 'down'
      const err = await submit(payload, []).catch((e) => e)
      expect(err.code).toBe('unreachable')
      expect(err.message).toContain('Failed to fetch')
      expect(errSpy).toHaveBeenCalled()
      expect(String(errSpy.mock.calls[0]![0])).toContain('https://dalil.example.com')
      mode = 'ok'
      expect((await flushPending())?.ref).toBe('SPACE-1')
    })

    it('offline -> queued', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      mode = 'down'
      const err = await submit(payload, []).catch((e) => e)
      expect(err.code).toBe('queued')
      expect(errSpy).not.toHaveBeenCalled()
    })

    it('a CSP violation makes the message mention connect-src', async () => {
      const ev = new Event('securitypolicyviolation')
      Object.defineProperty(ev, 'blockedURI', { value: 'https://dalil.example.com/v1/reports' })
      document.dispatchEvent(ev)
      mode = 'down'
      await submit(payload, []).catch(() => {})
      expect(String(errSpy.mock.calls[0]![0])).toContain("blocked by this page's Content-Security-Policy (connect-src)")
    })
  })
})
