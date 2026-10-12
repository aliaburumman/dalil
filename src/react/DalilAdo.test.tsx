// @vitest-environment jsdom
import 'fake-indexeddb/auto'
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

import { DalilProvider } from './index'
import { forgetToken, getToken, saveToken, __resetTokensForTests } from '../core/adoToken'

const ADO = { type: 'azure-devops' as const, org: 'acme', project: 'Web' }
const base = { project: 'space', destination: ADO, getContext: () => ({}), replay: false }
const PAT = 'my-secret-pat-0001'

let createMode: 'ok' | 401 | 403 | 'net'
let calls: { method: string; url: string }[]

function installFetch() {
  window.fetch = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
    const url = String(u)
    calls.push({ method: i?.method ?? 'GET', url })
    const auth = (i?.headers as Record<string, string> | undefined)?.authorization
    if (url.includes('/wit/workitemtypes')) {
      return auth === 'Basic ' + btoa(`:${PAT}`) || auth === 'Basic ' + btoa(':new-pat') ? new Response('{"value":[{"name":"Bug"}]}') : new Response('', { status: 401 })
    }
    if (url.includes('/wit/attachments')) return new Response(JSON.stringify({ url: 'https://dev.azure.com/acme/_apis/wit/attachments/x' }), { status: 201 })
    if (url.includes('/wit/workitems/$Bug')) {
      if (createMode === 'net') throw new TypeError('Failed to fetch')
      if (createMode !== 'ok') return new Response('', { status: createMode })
      return new Response(JSON.stringify({ id: 1234, _links: { html: { href: 'https://dev.azure.com/acme/g/_workitems/edit/1234' } } }))
    }
    return new Response('{}')
  }) as unknown as typeof fetch
}

function pressShortcut() {
  fireEvent.keyDown(window, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
}

const typePat = async (v: string) => {
  fireEvent.change(await screen.findByLabelText('Personal access token'), { target: { value: v } })
  fireEvent.click(screen.getByRole('button', { name: 'Validate & save' }))
}
const fillAndSend = async () => {
  fireEvent.change(await screen.findByLabelText('What went wrong?'), { target: { value: 'Payment fails' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  createMode = 'ok'
  calls = []
  installFetch()
  core.submit.mockReset()
  auto.snaps = []
  await forgetToken('acme')
  __resetTokensForTests()
})
afterEach(() => {
  cleanup()
  core.listeners.clear()
  vi.restoreAllMocks()
})

describe('Azure DevOps mode', () => {
  it('shows the Connect view when no token is stored, then the dialog after saving', async () => {
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    const connect = await screen.findByRole('dialog', { name: 'Connect Azure DevOps' })
    const field = screen.getByLabelText('Personal access token') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('off')
    const help = screen.getByRole('link', { name: 'Create a token in Azure DevOps' }) as HTMLAnchorElement
    expect(help.href).toBe('https://dev.azure.com/acme/_usersSettings/tokens')
    expect(connect.textContent).toContain('acme / Web')
    expect(shot.captureScreenshot).not.toHaveBeenCalled()
    await typePat(PAT)
    expect(await screen.findByLabelText('What went wrong?')).toBeTruthy()
    expect(await getToken('acme')).toBe(PAT)
  })

  it('shows an inline error for a rejected token and does not save it', async () => {
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    await typePat('wrong')
    expect((await screen.findByRole('alert')).textContent).toContain('rejected this token')
    expect(await getToken('acme')).toBeNull()
  })

  it('files the Bug and shows the Azure DevOps Sent panel', async () => {
    await saveToken('acme', 'Web', PAT)
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    await fillAndSend()
    expect(await screen.findByText('Created Bug #1234')).toBeTruthy()
    const open = screen.getByRole('link', { name: 'Open in Azure DevOps' }) as HTMLAnchorElement
    expect(open.href).toBe('https://dev.azure.com/acme/g/_workitems/edit/1234')
    expect(open.target).toBe('_blank')
    expect(open.rel).toContain('noopener')
    expect(screen.getByRole('button', { name: 'Copy report' })).toBeTruthy()
    expect(core.submit).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/workitems/$Bug'))).toBe(true)
  })

  it('401 on create: token-expired panel with Update token, Download evidence, Copy report; a new token retries', async () => {
    await saveToken('acme', 'Web', PAT)
    createMode = 401
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    await fillAndSend()
    expect(await screen.findByText('Your Azure DevOps token expired or was revoked.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download evidence (.zip)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy report' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update token' }))
    createMode = 'ok'
    await typePat('new-pat')
    expect(await screen.findByText('Created Bug #1234')).toBeTruthy()
    expect(await getToken('acme')).toBe('new-pat')
  })

  it('403 on create: scope/project message', async () => {
    await saveToken('acme', 'Web', PAT)
    createMode = 403
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    await fillAndSend()
    expect(await screen.findByText(/can't create work items in Web/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update token' })).toBeTruthy()
  })

  it('network failure: org message with Try again, which succeeds on retry; no data lost', async () => {
    await saveToken('acme', 'Web', PAT)
    createMode = 'net'
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    await fillAndSend()
    expect(await screen.findByText("Couldn't reach Azure DevOps org 'acme'. Check the org name, then try again.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download evidence (.zip)' })).toBeTruthy()
    createMode = 'ok'
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Created Bug #1234')).toBeTruthy()
  })

  it('Forget token in the dialog removes it', async () => {
    await saveToken('acme', 'Web', PAT)
    render(<DalilProvider {...base} enabled hideButton />)
    pressShortcut()
    fireEvent.click(await screen.findByRole('button', { name: 'Forget token' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await getToken('acme')).toBeNull()
  })
})
