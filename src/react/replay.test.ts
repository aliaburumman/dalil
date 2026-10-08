// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rr = vi.hoisted(() => {
  const state = { emit: null as null | ((e: unknown) => void), opts: null as null | Record<string, unknown> }
  const addCustomEvent = vi.fn()
  const record = Object.assign(
    vi.fn((opts: Record<string, unknown>) => {
      state.opts = opts
      state.emit = opts.emit as (e: unknown) => void
      return vi.fn()
    }),
    { addCustomEvent },
  )
  return { state, addCustomEvent, record }
})
vi.mock('@rrweb/record', () => ({ record: rr.record }))

import { __resetForTests, init, log } from '../core'
import { startReplay, type ReplayHandle } from './replay'

let t = 1_000
const meta = () => rr.state.emit!({ type: 4, timestamp: (t += 10), data: {} })
const full = (pad = 0) => rr.state.emit!({ type: 2, timestamp: (t += 10), data: { node: 'x'.repeat(pad) } })
const inc = (n = 1) => {
  for (let i = 0; i < n; i++) rr.state.emit!({ type: 3, timestamp: (t += 10), data: { source: 1 } })
}
const segment = (pad = 0, incs = 2) => {
  meta()
  full(pad)
  inc(incs)
}

let h: ReplayHandle
beforeEach(() => {
  rr.record.mockClear()
  rr.addCustomEvent.mockClear()
  init({ project: 'p', publicKey: 'k', endpoint: 'https://x.test/v1/reports' })
  h = startReplay()
})
afterEach(() => {
  h.stop()
  __resetForTests()
})

describe('replay recorder config', () => {
  it('records with strict masking options', () => {
    const o = rr.state.opts!
    expect(o).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '[data-dalil-mask], [contenteditable]',
      blockSelector: 'iframe,canvas,[data-dalil-ignore]',
      inlineStylesheet: true,
      recordCanvas: false,
      collectFonts: false,
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
      checkoutEveryNms: 60_000,
    })
    expect((o.maskInputOptions as Record<string, boolean>).password).toBe(true)
    expect(Object.values(o.maskInputOptions as Record<string, boolean>).every(Boolean)).toBe(true)
  })
})

describe('segments', () => {
  it('keeps at most 2 whole segments, each starting at Meta + FullSnapshot', async () => {
    segment()
    segment()
    segment()
    segment()
    expect(h.info()!.events).toBe(2 * 4)
    const out = await h.prepare()
    expect('blob' in out).toBe(true)
    if (!('blob' in out)) return
    expect(out.meta.events).toBe(8)
  })

  it('reports the recorded duration', () => {
    segment()
    expect(h.info()!.durationMs).toBe(30)
  })

  it('drops the OLDER segment first when the event cap is exceeded, never cutting mid-segment', () => {
    segment(0, 20_000)
    segment(0, 20_000) // 40k > 30k: oldest segment dropped whole
    expect(h.info()!.events).toBe(20_002)
    expect(h.status().state).toBe('recording')
  })

  it('stops recording, with a reason, when a single segment exceeds the cap', async () => {
    segment(0, 31_000)
    expect(h.status()).toMatchObject({ state: 'stopped' })
    expect(h.info()).toBeNull()
    expect(await h.prepare()).toEqual({ error: expect.stringContaining('too heavy') })
  })

  it('stops when one full snapshot is over the byte estimate', () => {
    meta()
    full(16 * 1024 * 1024)
    expect(h.status().state).toBe('stopped')
  })

  it('returns an error and no blob when CompressionStream is missing', async () => {
    h.stop()
    const orig = globalThis.CompressionStream
    // @ts-expect-error simulate old Safari
    delete globalThis.CompressionStream
    try {
      const h2 = startReplay()
      expect(h2.status().state).toBe('unsupported')
      expect(await h2.prepare()).toEqual({ error: 'unsupported' })
    } finally {
      globalThis.CompressionStream = orig
    }
  })
})

describe('markers', () => {
  it('queues markers until the first FullSnapshot, then flushes them in order', () => {
    log('Toast: Failed to save payment', undefined, 'error')
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    expect(rr.addCustomEvent).not.toHaveBeenCalled()
    meta()
    expect(rr.addCustomEvent).not.toHaveBeenCalled()
    full()
    expect(rr.addCustomEvent).toHaveBeenCalledTimes(2)
    expect(rr.addCustomEvent.mock.calls[0]).toEqual(['dalil', expect.objectContaining({ kind: 'toast', label: 'Toast: Failed to save payment' })])
    expect(rr.addCustomEvent.mock.calls[1]).toEqual(['dalil', expect.objectContaining({ kind: 'error' })])
  })

  it('mirrors later failures immediately and ignores non-error logs', () => {
    segment()
    log('just info')
    expect(rr.addCustomEvent).not.toHaveBeenCalled()
    log('Zod drift', undefined, 'error')
    expect(rr.addCustomEvent).toHaveBeenCalledWith('dalil', expect.objectContaining({ kind: 'log', eventId: expect.any(String) }))
  })
})

describe('prepare', () => {
  it('drops the older segment, then gives up, when over the compressed cap', async () => {
    // Incompressible-ish payloads so gzip can't shrink them below 5 MB.
    const noise = (n: number) => Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join('')
    segment(0, 0)
    rr.state.emit!({ type: 3, timestamp: (t += 10), data: { source: 1, noise: noise(900_000) } })
    segment(0, 0)
    rr.state.emit!({ type: 3, timestamp: (t += 10), data: { source: 1, noise: noise(1_000) } })
    const out = await h.prepare()
    expect('blob' in out).toBe(true)
    if ('blob' in out) expect(out.meta.events).toBe(2 + 1 + 2 + 1 - 3) // only the newer segment survived
  }, 30_000)

  it('skips with an error when a lone segment is still over the cap', async () => {
    const noise = Array.from({ length: 900_000 }, () => Math.random().toString(36).slice(2)).join('')
    meta()
    rr.state.emit!({ type: 2, timestamp: (t += 10), data: { noise } })
    const out = await h.prepare()
    expect(out).toEqual({ error: 'Recording too large to send' })
  }, 60_000)
})
