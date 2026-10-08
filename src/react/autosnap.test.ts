// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests, init, snapshot } from '../core'
import { __resetAutoSnapsForTests, fitUnder, getAutoSnaps, startAutoSnap } from './autosnap'

const IMG = 'data:image/jpeg;base64,AAAA'
let capture: ReturnType<typeof vi.fn>
let stop: () => void

const toast = (attrs: Record<string, string>, text: string) => {
  const el = document.createElement('li')
  el.setAttribute('data-sonner-toast', '')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.textContent = text
  document.body.appendChild(el)
  return el
}
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  window.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
  init({ project: 'p', publicKey: 'k', endpoint: 'https://x.test/v1/reports' })
  capture = vi.fn(async () => IMG)
  stop = startAutoSnap({ capture: capture as unknown as () => Promise<string> })
})
afterEach(() => {
  stop()
  __resetForTests()
  __resetAutoSnapsForTests()
  vi.useRealTimers()
})

describe('auto-snapshots', () => {
  it('captures an error toast after 300 ms and logs it into the timeline', async () => {
    toast({ 'data-type': 'error', 'data-id': '1' }, 'Failed to save payment')
    await flush()
    expect(snapshot().events.some((e) => e.type === 'log' && e.level === 'error' && e.message === 'Toast: Failed to save payment')).toBe(true)
    await vi.advanceTimersByTimeAsync(299)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(capture).toHaveBeenCalledTimes(1)
    const [s] = getAutoSnaps()
    expect(s).toMatchObject({ reason: 'toast', label: 'Error toast: Failed to save payment' })
    expect(s!.eventId).toBeTruthy()
  })

  it('ignores non-error toasts, dedupes by data-id within 10 s, and sees a toast turn into an error', async () => {
    const t = toast({ 'data-type': 'success', 'data-id': '7' }, 'Saved')
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture).not.toHaveBeenCalled()
    t.setAttribute('data-type', 'error') // toast.promise resolving to an error
    await vi.advanceTimersByTimeAsync(400)
    expect(capture).toHaveBeenCalledTimes(1)
    toast({ 'data-type': 'error', 'data-id': '7' }, 'Saved') // same id: deduped
    await vi.advanceTimersByTimeAsync(5000)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(snapshot().events.filter((e) => e.type === 'log').length).toBe(1)
  })

  it('redacts and truncates toast text to 200 chars', async () => {
    toast({ 'data-type': 'error', 'data-id': 'a' }, 'Bearer abc.def.ghi ' + 'x'.repeat(400))
    await flush()
    const e = snapshot().events.find((x) => x.type === 'log')!
    expect(e.type === 'log' && e.message.length).toBeLessThanOrEqual('Toast: '.length + 200)
    expect(JSON.stringify(e)).not.toContain('abc.def.ghi')
  })

  it('captures 700 ms after a failed request and throttles to one per 4 s', async () => {
    await fetch('https://api.test/Payment/Create', { method: 'POST' })
    await vi.advanceTimersByTimeAsync(699)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(getAutoSnaps()[0]).toMatchObject({ reason: 'request' })
    await fetch('https://api.test/Other', { method: 'POST' }) // inside the 4 s window
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    await fetch('https://api.test/Other', { method: 'POST' })
    await vi.advanceTimersByTimeAsync(800)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('captures on an error event and keeps a ring of the last 3', async () => {
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new ErrorEvent('error', { message: `boom ${i}` }))
      await vi.advanceTimersByTimeAsync(5000)
    }
    const snaps = getAutoSnaps()
    expect(snaps).toHaveLength(3)
    expect(snaps.map((s) => s.label)).toEqual(['Error: boom 1', 'Error: boom 2', 'Error: boom 3'])
  })

  it('skips when the document is hidden, including when it hides before the callback', async () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'a' }))
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture).not.toHaveBeenCalled()
    window.dispatchEvent(new ErrorEvent('error', { message: 'b' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture).not.toHaveBeenCalled()
  })

  it('stops trying after a capture took longer than 800 ms', async () => {
    capture.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 900))
      return IMG
    })
    window.dispatchEvent(new ErrorEvent('error', { message: 'slow' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(capture).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new ErrorEvent('error', { message: 'again' }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('does not capture after stop()', async () => {
    stop()
    window.dispatchEvent(new ErrorEvent('error', { message: 'x' }))
    toast({ 'data-type': 'error', 'data-id': 'z' }, 'nope')
    await vi.advanceTimersByTimeAsync(2000)
    expect(capture).not.toHaveBeenCalled()
  })

  it('fitUnder returns small images untouched and null when it cannot shrink', async () => {
    expect(await fitUnder(IMG, 400_000)).toBe(IMG)
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(600_000)
    const p = fitUnder(big, 400_000)
    await vi.advanceTimersByTimeAsync(2100)
    expect(await p).toBeNull() // jsdom cannot decode: dropped, never oversize
  })
})
