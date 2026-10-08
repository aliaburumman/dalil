// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    init: vi.fn(),
    log: vi.fn(),
    snapshot: vi.fn(() => ({ events: [], verdict: { kind: 'unknown', headline: 'x', confidence: 'low', alsoSeen: [] }, curls: {} })),
    open: vi.fn(() => listeners.forEach((l) => l())),
    onOpen: vi.fn((cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    submit: vi.fn(),
    DalilSubmitError: class extends Error {},
    redactUrl: (u: string) => u,
    redactText: (t: string) => t,
    onEvent: vi.fn(() => () => {}),
    LIMITS: { autoSnaps: 3, autoSnapBytes: 400_000, replayBytes: 5_000_000, replayDecompressedBytes: 40_000_000, bodyBytes: 8_000_000 },
  }
})
vi.mock('../core', () => ({ PAYLOAD_VERSION: 1, ...core }))
vi.mock('../react/screenshot', () => ({ captureScreenshot: vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=') }))
const autoStop = vi.hoisted(() => vi.fn())
vi.mock('../react/autosnap', () => ({ getAutoSnaps: () => [], startAutoSnap: vi.fn(() => autoStop) }))
const rep = vi.hoisted(() => {
  const handle = { stop: vi.fn(), status: vi.fn(() => ({ state: 'recording' })), info: vi.fn(() => ({ durationMs: 1, events: 1 })), prepare: vi.fn() }
  return { handle, startReplay: vi.fn(() => handle) }
})
vi.mock('../react/replay', () => ({ startReplay: rep.startReplay }))

import { destroy, init, open, update } from './index'

const cfg = { project: 'p', publicKey: 'pk', endpoint: 'https://c.test/v1/reports' }
const host = () => document.querySelector('dalil-root') as HTMLElement | null
const shadow = () => host()?.shadowRoot ?? null
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
async function until(fn: () => unknown) {
  for (let i = 0; i < 100 && !fn(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}
const fab = () => shadow()?.querySelector('.dalil-fab') ?? null

beforeEach(() => {
  core.init.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => destroy())
  core.listeners.clear()
  vi.restoreAllMocks()
  autoStop.mockClear()
  rep.handle.stop.mockClear()
})

describe('dalil/web', () => {
  it('mounts <dalil-root> with an open shadow root containing the button', async () => {
    await act(async () => init({ ...cfg }))
    expect(host()?.hasAttribute('data-dalil-ignore')).toBe(true)
    expect(shadow()).not.toBeNull()
    expect(fab()).not.toBeNull()
    expect(core.init).toHaveBeenCalled() // recorder starts immediately
  })

  it('is idempotent', async () => {
    await act(async () => init({ ...cfg }))
    await act(async () => init({ ...cfg }))
    expect(document.querySelectorAll('dalil-root')).toHaveLength(1)
  })

  it('keeps styles in the shadow root and out of document.head', async () => {
    const before = document.head.querySelectorAll('style').length
    await act(async () => init({ ...cfg }))
    await flush()
    expect(shadow()!.querySelector('style#dalil-styles')).not.toBeNull()
    expect(document.head.querySelectorAll('style').length).toBe(before)
    expect(document.getElementById('dalil-styles')).toBeNull()
  })

  it('update({enabled:false}) hides the button; update re-enables', async () => {
    await act(async () => init({ ...cfg }))
    await act(async () => update({ enabled: false }))
    expect(fab()).toBeNull()
    await act(async () => update({ enabled: true, theme: 'dark', accent: '#0ea5e9' }))
    expect(fab()).not.toBeNull()
    expect(host()!.getAttribute('data-theme')).toBe('dark')
    expect(host()!.style.getPropertyValue('--dalil-accent')).toBe('#0ea5e9')
  })

  it('open() renders the dialog inside the shadow root; Esc closes it', async () => {
    await act(async () => init({ ...cfg }))
    await act(async () => open())
    await until(() => shadow()!.querySelector('[role=dialog]'))
    const dialog = shadow()!.querySelector('[role=dialog]')
    expect(dialog).not.toBeNull()
    expect(document.body.querySelector('[role=dialog]')).toBeNull()
    await act(async () => {
      dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await until(() => !shadow()!.querySelector('[role=dialog]'))
    expect(shadow()!.querySelector('[role=dialog]')).toBeNull()
  })

  it('destroy() removes the element and stops replay and auto-snapshots', async () => {
    await act(async () => init({ ...cfg }))
    await until(() => rep.startReplay.mock.calls.length)
    expect(rep.startReplay).toHaveBeenCalled()
    await act(async () => destroy())
    expect(host()).toBeNull()
    expect(autoStop).toHaveBeenCalled()
    expect(rep.handle.stop).toHaveBeenCalled()
  })
})
