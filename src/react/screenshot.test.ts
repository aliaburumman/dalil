// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Opts = { filter: (n: Node) => boolean; quality: number; canvasWidth: number }
const h2i = vi.hoisted(() => ({ toJpeg: vi.fn() }))
vi.mock('html-to-image', () => h2i)

import { captureScreenshot } from './screenshot'

function fixture() {
  document.body.innerHTML = `
    <img id="xo" src="https://pub-1.r2.dev/logo.png">
    <img id="xo-cors" crossorigin="anonymous" src="https://cdn.example.com/a.png">
    <img id="same" src="${location.origin}/local.png">
    <img id="inline" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <div id="bg" style="background-image:url(https://pub-1.r2.dev/bg.png)">x</div>
    <div data-dalil-mask id="secret">4111</div>`
}

beforeEach(() => {
  h2i.toJpeg.mockReset()
  fixture()
})
afterEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('#dalil-mask-style').forEach((n) => n.remove())
  vi.useRealTimers()
})

const el = (id: string) => document.getElementById(id)!

describe('captureScreenshot fallback', () => {
  it('retries once, excluding cross-origin images but keeping same-origin ones', async () => {
    h2i.toJpeg.mockRejectedValueOnce(new Event('error')).mockResolvedValueOnce('data:image/jpeg;base64,AAA')
    const out = await captureScreenshot()
    expect(out).toBe('data:image/jpeg;base64,AAA')
    expect(h2i.toJpeg).toHaveBeenCalledTimes(2)
    const first = (h2i.toJpeg.mock.calls[0]![1] as Opts).filter
    const second = (h2i.toJpeg.mock.calls[1]![1] as Opts).filter
    expect(first(el('xo'))).toBe(true) // attempt 1 keeps everything
    expect(second(el('xo'))).toBe(false)
    expect(second(el('same'))).toBe(true)
    expect(second(el('xo-cors'))).toBe(true)
    expect(second(el('inline'))).toBe(true)
  })

  it('reports the failure when attempt 2 also rejects', async () => {
    h2i.toJpeg.mockRejectedValue(new Event('error'))
    await expect(captureScreenshot()).rejects.toThrow(/failed to load/)
    expect(h2i.toJpeg).toHaveBeenCalledTimes(2)
  })

  it('shares one 4 s budget: a timed-out first attempt does not get a second', async () => {
    vi.useFakeTimers()
    h2i.toJpeg.mockReturnValue(new Promise(() => {}))
    const p = captureScreenshot()
    const assertion = expect(p).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(4100)
    await assertion
    expect(h2i.toJpeg).toHaveBeenCalledTimes(1)
  })

  it('tags cross-origin backgrounds only during attempt 2 and untags afterwards', async () => {
    let tagged = false
    el('bg').getBoundingClientRect = () => ({ top: 10, bottom: 30, height: 20, left: 0, right: 10, width: 10, x: 0, y: 10, toJSON() {} }) as DOMRect
    h2i.toJpeg
      .mockRejectedValueOnce(new Event('error'))
      .mockImplementationOnce(async () => {
        tagged = el('bg').hasAttribute('data-dalil-xo-bg')
        return 'data:image/jpeg;base64,AAA'
      })
    await captureScreenshot()
    expect(tagged).toBe(true)
    expect(el('bg').hasAttribute('data-dalil-xo-bg')).toBe(false)
  })

  it('auto captures do not flip a class on <html>, mask through the filter, and use low quality', async () => {
    let classDuring = true
    h2i.toJpeg.mockImplementationOnce(async () => {
      classDuring = document.documentElement.classList.contains('dalil-capturing')
      return 'data:image/jpeg;base64,AAA'
    })
    await captureScreenshot({ auto: true })
    expect(classDuring).toBe(false)
    const o = h2i.toJpeg.mock.calls[0]![1] as Opts
    expect(o.quality).toBe(0.5)
    expect(o.filter(el('secret'))).toBe(false)
    expect(o.canvasWidth).toBeLessThanOrEqual(1280)
  })

  it('manual captures flip the mask class and restore it', async () => {
    let classDuring = false
    h2i.toJpeg.mockImplementationOnce(async () => {
      classDuring = document.documentElement.classList.contains('dalil-capturing')
      return 'x'
    })
    await captureScreenshot()
    expect(classDuring).toBe(true)
    expect(document.documentElement.classList.contains('dalil-capturing')).toBe(false)
    expect(document.getElementById('dalil-mask-style')).toBeNull()
  })
})
