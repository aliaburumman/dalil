import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests, init } from './recorder'
import { DalilSubmitError, flushPending, submit } from './submit'
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
    expect(call.url).toBe(cfg.endpoint)
    expect((call.init.headers as Record<string, string>)['X-Dalil-Key']).toBe('pk_1')
    const fd = call.init.body as FormData
    expect(fd.get('report')).toBeTruthy()
    expect(fd.get('image_0')).toBeTruthy()
  })

  it('throws rejected on non-2xx', async () => {
    mode = 'reject'
    await expect(submit(payload, [])).rejects.toMatchObject({ code: 'rejected', status: 403, message: 'bad key' })
  })

  it('queues on network failure and flushPending resends', async () => {
    mode = 'down'
    const err = await submit(payload, []).catch((e) => e)
    expect(err).toBeInstanceOf(DalilSubmitError)
    expect(err.code).toBe('queued')
    expect(await flushPending()).toBeNull() // still down: kept
    mode = 'ok'
    const r = await flushPending()
    expect(r?.ref).toBe('SPACE-1')
    expect(await flushPending()).toBeNull() // gone
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
})
