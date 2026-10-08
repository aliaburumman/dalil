// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    init: vi.fn(),
    log: vi.fn(),
    getConfig: vi.fn(() => null),
    snapshot: vi.fn(() => ({
      events: [
        { id: 'e1', t: 1, type: 'click', label: 'Save', tag: 'button' },
        {
          id: 'e2',
          t: 2,
          type: 'request',
          method: 'POST',
          url: 'https://api.test/Payment/Create',
          status: 500,
          durationMs: 10,
          outcome: 'http_error',
        },
      ],
      verdict: {
        kind: 'backend',
        headline: 'Backend error: 500 on POST /Payment/Create',
        confidence: 'high',
        evidenceEventId: 'e2',
        alsoSeen: [],
      },
      curls: { e2: "curl -X POST 'https://api.test/Payment/Create'" },
    })),
    open: vi.fn(() => listeners.forEach((l) => l())),
    onOpen: vi.fn((cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    submit: vi.fn(),
    DalilSubmitError: class DalilSubmitError extends Error {
      code: string
      constructor(code: string, message: string) {
        super(message)
        this.code = code
      }
    },
    redactUrl: vi.fn((u: string) => u),
    redactText: vi.fn((t: string) => t),
    onEvent: vi.fn(() => () => {}),
    LIMITS: { autoSnaps: 3, autoSnapBytes: 400_000, replayBytes: 5_000_000, replayDecompressedBytes: 40_000_000, bodyBytes: 8_000_000 },
  }
})

vi.mock('../core', () => ({ PAYLOAD_VERSION: 1, ...core }))

const shot = vi.hoisted(() => ({
  // 1x1 transparent GIF; any base64 data URL works for the Blob fallback.
  captureScreenshot: vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
}))
vi.mock('./screenshot', () => shot)

const auto = vi.hoisted(() => ({
  snaps: [] as { t: number; reason: string; label: string; eventId?: string; dataUrl: string }[],
  startAutoSnap: vi.fn(() => () => {}),
}))
vi.mock('./autosnap', () => ({ getAutoSnaps: () => auto.snaps, startAutoSnap: auto.startAutoSnap }))

const rep = vi.hoisted(() => {
  const handle = {
    stop: vi.fn(),
    status: vi.fn(() => ({ state: 'recording' })),
    info: vi.fn(() => ({ durationMs: 108_000, events: 40 })),
    prepare: vi.fn(),
  }
  return { handle, startReplay: vi.fn(() => handle) }
})
vi.mock('./replay', () => ({ startReplay: rep.startReplay }))

import { DalilProvider, useDalil } from './index'

const base = {
  project: 'space',
  publicKey: 'pk_test',
  endpoint: 'https://collector.test/v1/reports',
  getContext: () => ({ userId: 'u1', tenant: 'Acme' }),
}

function pressShortcut() {
  fireEvent.keyDown(window, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
}

async function openDialog() {
  pressShortcut()
  return screen.findByRole('dialog')
}

beforeEach(() => {
  // jsdom has no canvas; keep its "not implemented" noise out of the output.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  core.submit.mockReset()
  shot.captureScreenshot.mockClear()
  auto.snaps = []
  auto.startAutoSnap.mockClear()
  rep.startReplay.mockClear()
  rep.handle.stop.mockClear()
  rep.handle.prepare.mockReset()
})
afterEach(() => {
  cleanup()
  core.listeners.clear()
  vi.restoreAllMocks()
})

describe('DalilProvider', () => {
  it('renders no button when disabled, and ignores the shortcut', async () => {
    render(<DalilProvider {...base} enabled={false} />)
    expect(screen.queryByRole('button', { name: 'Report a bug' })).toBeNull()
    pressShortcut()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the button when enabled and calls init once', () => {
    const { rerender } = render(<DalilProvider {...base} enabled />)
    rerender(<DalilProvider {...base} enabled />)
    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeTruthy()
    expect(core.init).toHaveBeenCalledTimes(1)
  })

  it('hideButton hides the button but the shortcut still opens', async () => {
    render(<DalilProvider {...base} enabled hideButton />)
    expect(screen.queryByRole('button', { name: 'Report a bug' })).toBeNull()
    expect(await openDialog()).toBeTruthy()
  })

  it('shortcut captures the screenshot first, then opens the dialog', async () => {
    render(<DalilProvider {...base} enabled />)
    const dialog = await openDialog()
    expect(shot.captureScreenshot).toHaveBeenCalledTimes(1)
    expect(core.snapshot).toHaveBeenCalled()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('useDalil().open() opens the dialog through core onOpen', async () => {
    function Trigger() {
      const { open } = useDalil()
      return <button onClick={open}>host trigger</button>
    }
    render(
      <DalilProvider {...base} enabled hideButton>
        <Trigger />
      </DalilProvider>,
    )
    fireEvent.click(screen.getByText('host trigger'))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('Send is disabled until a title is typed; Esc closes', async () => {
    render(<DalilProvider {...base} enabled />)
    const dialog = await openDialog()
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'Payment fails' } })
    expect(send.disabled).toBe(false)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('submits a full payload with the screenshot part and shows the ref toast', async () => {
    core.submit.mockResolvedValue({ id: 'x', ref: 'SPACE-142', url: 'https://c/x' })
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'Payment fails' } })
    fireEvent.change(screen.getByLabelText('What did you expect?'), { target: { value: 'It saves' } })
    fireEvent.click(screen.getByLabelText('Blocker'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await waitFor(() => expect(core.submit).toHaveBeenCalledTimes(1))
    const [payload, parts] = core.submit.mock.calls[0] as [Record<string, unknown>, { part: string; blob: Blob }[]]
    expect(payload).toMatchObject({
      v: 1,
      project: 'space',
      title: 'Payment fails',
      expected: 'It saves',
      severity: 'blocker',
      verdict: { kind: 'backend' },
      context: { userId: 'u1', tenant: 'Acme' },
      images: [{ part: 'image_0', kind: 'screenshot', name: 'screenshot.jpg' }],
      curls: { e2: expect.any(String) },
    })
    expect((payload.events as unknown[]).length).toBe(2)
    expect(payload.env).toMatchObject({ viewport: expect.any(Object) })
    expect(payload.screenshotError).toBeUndefined()
    expect(parts).toHaveLength(1)
    expect(parts[0]?.part).toBe('image_0')
    expect(parts[0]?.blob).toBeInstanceOf(Blob)
    expect(await screen.findByText('Sent as SPACE-142')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('defaults severity to annoying and reports a failed capture', async () => {
    shot.captureScreenshot.mockRejectedValueOnce(new Error('Screenshot timed out after 4s'))
    core.submit.mockResolvedValue({ id: 'x', ref: 'SPACE-1', url: '' })
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    expect(screen.getByRole('note').textContent).toMatch(/couldn't capture/)
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(core.submit).toHaveBeenCalled())
    const [payload, parts] = core.submit.mock.calls[0] as [Record<string, unknown>, unknown[]]
    expect(payload.severity).toBe('annoying')
    expect(payload.images).toEqual([])
    expect(payload.screenshotError).toBe('Screenshot timed out after 4s')
    expect(parts).toEqual([])
  })

  it("'queued' closes with the offline toast", async () => {
    core.submit.mockRejectedValue(new core.DalilSubmitError('queued', 'offline'))
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Saved, will send when back online')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("'unreachable' closes with the unreachable toast", async () => {
    core.submit.mockRejectedValue(new core.DalilSubmitError('unreachable', 'blocked'))
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/Couldn't reach the bug-report server/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("'build_failed' keeps the form with an inline error", async () => {
    core.submit.mockRejectedValue(new core.DalilSubmitError('build_failed', 'boom'))
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/preparing the report/)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it("'rejected' keeps the form and shows an inline error", async () => {
    core.submit.mockRejectedValue(new core.DalilSubmitError('rejected', '400'))
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'kept text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn't be sent/)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByLabelText('What went wrong?') as HTMLTextAreaElement).value).toBe('kept text')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("'save_failed' keeps the form and shows the save-failed error", async () => {
    core.submit.mockRejectedValue(new core.DalilSubmitError('save_failed', 'no idb'))
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'kept text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn't be saved/)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByLabelText('What went wrong?') as HTMLTextAreaElement).value).toBe('kept text')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('rtl sets dir on the dialog root and labels can be overridden', async () => {
    render(
      <DalilProvider {...base} enabled dir="rtl" labels={{ button: 'أبلغ عن مشكلة', send: 'إرسال' }} />,
    )
    expect(screen.getByRole('button', { name: 'أبلغ عن مشكلة' })).toBeTruthy()
    const dialog = await openDialog()
    expect(dialog.getAttribute('dir')).toBe('rtl')
    expect(dialog.closest('[data-dalil-ignore]')?.getAttribute('dir')).toBe('rtl')
    expect(screen.getByRole('button', { name: 'إرسال' })).toBeTruthy()
  })

  it("theme='light' sets data-theme on the dialog root", async () => {
    render(<DalilProvider {...base} enabled theme="light" />)
    const dialog = await openDialog()
    expect(dialog.closest('.dalil-root')?.getAttribute('data-theme')).toBe('light')
  })

  it("theme defaults to 'system' with no data-theme", async () => {
    render(<DalilProvider {...base} enabled />)
    const dialog = await openDialog()
    expect(dialog.closest('.dalil-root')?.hasAttribute('data-theme')).toBe(false)
  })

  it('accent and accentForeground set the CSS vars on the root', async () => {
    render(<DalilProvider {...base} enabled accent="rgb(1, 2, 3)" accentForeground="rgb(4, 5, 6)" />)
    const root = screen.getByRole('button', { name: 'Report a bug' }).closest('.dalil-root') as HTMLElement
    expect(root.style.getPropertyValue('--dalil-accent')).toBe('rgb(1, 2, 3)')
    expect(root.style.getPropertyValue('--dalil-accent-fg')).toBe('rgb(4, 5, 6)')
  })

  it('uses the singular step label when there is one step', async () => {
    render(<DalilProvider {...base} enabled />)
    await openDialog()
    expect(screen.getByText('1 step')).toBeTruthy()
    expect(screen.queryByText('1 steps')).toBeNull()
  })
})

describe('v0.2: auto-snapshots and replay', () => {
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
  const send = async () => {
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send|Preparing/ }))
    })
    await waitFor(() => expect(core.submit).toHaveBeenCalled())
    return core.submit.mock.calls[0] as [Record<string, unknown>, { part: string; blob: Blob }[]]
  }
  const waitIdle = () => waitFor(() => expect(rep.startReplay).toHaveBeenCalled())

  it('starts auto-snapshots and replay only while enabled; replay={false} skips the recorder', async () => {
    const { unmount } = render(<DalilProvider {...base} enabled={false} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(auto.startAutoSnap).not.toHaveBeenCalled()
    expect(rep.startReplay).not.toHaveBeenCalled()
    unmount()
    const r2 = render(<DalilProvider {...base} enabled replay={false} />)
    await waitFor(() => expect(auto.startAutoSnap).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(rep.startReplay).not.toHaveBeenCalled()
    r2.unmount()
  })

  it('stops the recorder when the host disables the widget', async () => {
    const { rerender } = render(<DalilProvider {...base} enabled />)
    await waitIdle()
    rerender(<DalilProvider {...base} enabled={false} />)
    expect(rep.handle.stop).toHaveBeenCalled()
  })

  it('shows the captured-automatically strip, lets the tester remove one, and sends the rest as auto_N', async () => {
    auto.snaps = [
      { t: 1_000, reason: 'toast', label: 'Error toast: Failed to save payment', eventId: 'e9', dataUrl: GIF },
      { t: 2_000, reason: 'request', label: 'POST /Payment/Create → 500', eventId: 'e2', dataUrl: GIF },
    ]
    core.submit.mockResolvedValue({ id: 'x', ref: 'S-1', url: '' })
    render(<DalilProvider {...base} enabled replay={false} />)
    await waitFor(() => expect(auto.startAutoSnap).toHaveBeenCalled())
    await openDialog()
    expect(screen.getByText('Captured automatically')).toBeTruthy()
    expect(screen.getByText(/Failed to save payment/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove this capture' })[0]!)
    expect(screen.queryByText(/Failed to save payment/)).toBeNull()
    const [payload, parts] = await send()
    expect(payload.autoSnaps).toEqual([
      { part: 'auto_0', t: 2_000, reason: 'request', label: 'POST /Payment/Create → 500', eventId: 'e2' },
    ])
    expect(parts.map((p) => p.part)).toEqual(['image_0', 'auto_0'])
    expect(payload.replay).toBeUndefined()
    expect(payload.replayError).toBeUndefined()
  })

  it('attaches the replay part with metadata and lists it under what will be sent', async () => {
    rep.handle.prepare.mockResolvedValue({
      blob: new Blob(['gz'], { type: 'application/gzip' }),
      meta: { part: 'replay', durationMs: 108_000, events: 40, bytes: 2, rrweb: '2.1.7' },
    })
    core.submit.mockResolvedValue({ id: 'x', ref: 'S-1', url: '' })
    render(<DalilProvider {...base} enabled />)
    await waitIdle()
    await openDialog()
    expect(screen.getByText('Screen recording: last 1m 48s (inputs hidden)')).toBeTruthy()
    const [payload, parts] = await send()
    expect(payload.replay).toMatchObject({ part: 'replay', events: 40, rrweb: '2.1.7' })
    expect(parts.map((p) => p.part)).toEqual(['image_0', 'replay'])
  })

  it('excluding the recording sends no replay part and says why', async () => {
    core.submit.mockResolvedValue({ id: 'x', ref: 'S-1', url: '' })
    render(<DalilProvider {...base} enabled />)
    await waitIdle()
    await openDialog()
    fireEvent.click(screen.getByLabelText('Include the screen recording'))
    const [payload, parts] = await send()
    expect(rep.handle.prepare).not.toHaveBeenCalled()
    expect(payload.replay).toBeUndefined()
    expect(payload.replayError).toBe('excluded by tester')
    expect(parts.map((p) => p.part)).toEqual(['image_0'])
  })

  it('shows "Preparing recording…" while serialising and reports a prepare error as replayError', async () => {
    let finish!: (v: unknown) => void
    rep.handle.prepare.mockReturnValue(new Promise((r) => (finish = r)))
    core.submit.mockResolvedValue({ id: 'x', ref: 'S-1', url: '' })
    render(<DalilProvider {...base} enabled />)
    await waitIdle()
    await openDialog()
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('button', { name: 'Preparing recording…' })).toBeTruthy()
    await act(async () => finish({ error: 'Recording too large to send' }))
    await waitFor(() => expect(core.submit).toHaveBeenCalled())
    const [payload, parts] = core.submit.mock.calls[0] as [Record<string, unknown>, unknown[]]
    expect(payload.replayError).toBe('Recording too large to send')
    expect(parts).toHaveLength(1)
  })

  it('drops the replay first when the body would exceed the limit', async () => {
    rep.handle.prepare.mockResolvedValue({
      blob: new Blob([new Uint8Array(8_100_000)], { type: 'application/gzip' }),
      meta: { part: 'replay', durationMs: 1, events: 1, bytes: 8_100_000, rrweb: '2.1.7' },
    })
    core.submit.mockResolvedValue({ id: 'x', ref: 'S-1', url: '' })
    render(<DalilProvider {...base} enabled />)
    await waitIdle()
    await openDialog()
    const [payload, parts] = await send()
    expect(payload.replay).toBeUndefined()
    expect(payload.replayError).toMatch(/size limit/)
    expect(parts.map((p) => p.part)).toEqual(['image_0'])
  })
})
