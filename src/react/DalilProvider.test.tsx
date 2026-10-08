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
  }
})

vi.mock('../core', () => ({ PAYLOAD_VERSION: 1, ...core }))

const shot = vi.hoisted(() => ({
  // 1x1 transparent GIF; any base64 data URL works for the Blob fallback.
  captureScreenshot: vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
}))
vi.mock('./screenshot', () => shot)

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
