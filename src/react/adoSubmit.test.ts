import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests, init, snapshot } from '../core/recorder'
import type { AdoDestination, ReportPayload } from '../core/types'
import { crc32 } from '../core/zip'
import { __resetPlayerCacheForTests } from './portableReplay'
import { buildEvidenceZip, prepareAdoReport, sendAdoReport } from './adoSubmit'

// The bundled player is also unavailable when a test simulates "cannot load".
const bundle = vi.hoisted(() => ({ ok: true }))
vi.mock('./playerAssets.generated', () => ({
  get PLAYER_JS() {
    if (!bundle.ok) throw new Error('no bundle')
    return 'window.rrwebPlayer=1'
  },
  get PLAYER_CSS() {
    return '.css{}'
  },
}))

const PAT = 'sup3rS3cretPAT0123456789'
const BASIC = btoa(`:${PAT}`)
const dest: AdoDestination = { type: 'azure-devops', org: 'acme', project: 'Web', areaPath: 'Web\\QA', tags: ['qa'] }
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-ghi'

const payload = {
  v: 2,
  project: 'space',
  createdAt: Date.UTC(2026, 9, 12, 8, 30, 0),
  title: `Save fails ${JWT}`,
  severity: 'annoying',
  verdict: { kind: 'backend', headline: 'Backend error: 500 on POST /Payment/Create', confidence: 'high', evidenceEventId: 'e2', alsoSeen: [] },
  context: {},
  env: { url: 'https://app.test/pay', userAgent: 'x', language: 'en', timezone: 'UTC', viewport: { w: 1, h: 1, dpr: 1 }, online: true },
  events: [
    { id: 'e1', t: 1, type: 'click', label: 'Save', tag: 'button' },
    { id: 'e2', t: 2, type: 'request', method: 'POST', url: 'https://api.test/Payment/Create', status: 500, durationMs: 5, outcome: 'http_error' },
  ],
  curls: { e2: `curl -H 'Authorization: Bearer ${JWT}'` },
  images: [
    { part: 'image_0', kind: 'screenshot', name: 'screenshot.jpg' },
    { part: 'image_1', kind: 'attachment', name: 'extra.png' },
  ],
  autoSnaps: [{ part: 'auto_0', t: 2, reason: 'request', label: 'POST /Payment/Create → 500', eventId: 'e2' }],
  replay: { part: 'replay', durationMs: 42_000, events: 2, bytes: 10, rrweb: '2.1.7' },
} as unknown as ReportPayload

const blob = (s: string, type = 'image/jpeg') => new Blob([s], { type })
const uploads = () => [
  { part: 'image_0', name: 'screenshot.jpg', blob: blob('shot0') },
  { part: 'image_1', name: 'extra.png', blob: blob('shot1', 'image/png') },
  { part: 'auto_0', name: 'auto_0.jpg', blob: blob('auto0') },
  { part: 'replay', name: 'replay.json.gz', blob: new Blob([new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3])]) },
]

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
let calls: Call[]
let delays: Record<string, number>
let createStatus: number
let playerOk: boolean
let netDown: boolean
const logs: unknown[][] = []

beforeEach(() => {
  calls = []
  delays = {}
  createStatus = 200
  playerOk = true
  bundle.ok = true
  netDown = false
  __resetPlayerCacheForTests()
  logs.length = 0
  for (const k of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation((...a) => void logs.push(a))
  window.fetch = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
    const url = String(u)
    if (netDown) throw new TypeError('Failed to fetch')
    calls.push({ method: i?.method ?? 'GET', url, headers: (i?.headers ?? {}) as Record<string, string>, body: i?.body })
    if (url.startsWith('https://player.test/')) {
      if (!playerOk) throw new TypeError('blocked')
      return new Response(url.endsWith('.js') ? 'window.rrwebPlayer=1' : '.css{}')
    }
    if (!url.startsWith('https://dev.azure.com/')) return new Response('nope', { status: 404 })
    const name = new URL(url).searchParams.get('fileName')
    if (url.includes('/wit/attachments')) {
      await new Promise((r) => setTimeout(r, delays[name!] ?? 0))
      return new Response(JSON.stringify({ url: `https://dev.azure.com/acme/_apis/wit/attachments/${encodeURIComponent(name!)}` }), { status: 201 })
    }
    if (url.includes('/wit/workitems/$Bug')) {
      return new Response(JSON.stringify({ id: 1234, _links: { html: { href: 'https://dev.azure.com/acme/guid/_workitems/edit/1234' } } }), { status: createStatus })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  init({ project: 'space', destination: dest, playerUrl: 'https://player.test/p/' })
})

afterEach(() => {
  __resetForTests()
  vi.restoreAllMocks()
})

const prep = () => prepareAdoReport({ payload, uploads: uploads(), playerUrl: 'https://player.test/p/' })

describe('prepareAdoReport', () => {
  it('scrubs secrets from the payload and builds a share without a link', async () => {
    const p = await prep()
    const json = JSON.stringify(p.payload)
    expect(p.scrubbed).toBe(true)
    expect(json).not.toContain(JWT)
    expect(json).toContain('[JWT]')
    expect(p.share.html).not.toContain('Full evidence')
    expect(p.share.text).not.toContain(JWT)
  })

  it('orders uploads: screenshots, auto-snaps; replay is the portable html', async () => {
    const p = await prep()
    expect(p.uploads.map((u) => u.name)).toEqual(['screenshot-1.jpg', 'screenshot-2.png', 'auto-1-post-payment-create-500.jpg'])
    expect(p.replay!.portable).toBe(true)
    expect(p.replay!.name).toBe('replay-20261012-083000.html')
    expect(await p.replay!.blob.text()).toContain('window.rrwebPlayer=1')
  })

  it('falls back to the raw gz when the player cannot load', async () => {
    playerOk = false
    bundle.ok = false
    const p = await prep()
    expect(p.replay!.portable).toBe(false)
    expect(p.replay!.name).toBe('replay-20261012-083000.json.gz')
  })
})

describe('sendAdoReport', () => {
  it('uploads 3 at a time keeping order even when they finish out of order, then creates the Bug', async () => {
    const p = await prep()
    delays = { 'screenshot-1.jpg': 40, 'screenshot-2.png': 5 }
    calls.length = 0
    const res = await sendAdoReport({ prepared: p, dest, pat: PAT })
    const uploadsSeen = calls.filter((c) => c.url.includes('/wit/attachments')).map((c) => new URL(c.url).searchParams.get('fileName'))
    expect(uploadsSeen).toEqual(['screenshot-1.jpg', 'screenshot-2.png', 'auto-1-post-payment-create-500.jpg', 'replay-20261012-083000.html'])
    const create = calls.find((c) => c.url.includes('/wit/workitems/$Bug'))!
    expect(create.headers.authorization).toBe(`Basic ${BASIC}`)
    const patch = JSON.parse(create.body as string) as { path: string; value: unknown }[]
    const body = String(patch.find((x) => x.path.endsWith('ReproSteps'))!.value)
    // media in upload order, not completion order
    expect(body.indexOf('screenshot-1.jpg')).toBeGreaterThan(-1)
    expect(body.indexOf('screenshot-1.jpg')).toBeLessThan(body.indexOf('screenshot-2.png'))
    expect(body.indexOf('screenshot-2.png')).toBeLessThan(body.indexOf('auto-1-post'))
    expect(body).toContain('Auto: POST /Payment/Create → 500')
    expect(body).toContain('▶ Open replay-20261012-083000.html (0:42)')
    expect(body).toContain('attachments/replay-20261012-083000.html')
    expect(patch.find((x) => x.path === '/fields/System.Tags')!.value).toBe('dalil; qa')
    expect(patch.find((x) => x.path === '/fields/System.AreaPath')!.value).toBe('Web\\QA')
    expect(patch.filter((x) => x.path === '/relations/-')).toHaveLength(4)
    // the replay is linked in the create call itself; no follow-up PATCH
    expect(patch.filter((x) => x.path === '/relations/-' && JSON.stringify(x.value).includes('replay-20261012-083000.html'))).toHaveLength(1)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(patch.find((x) => x.path === '/fields/System.Title')!.value).toBe('Save fails [JWT]')
    expect(res.id).toBe(1234)
    expect(res.url).toBe('https://dev.azure.com/acme/guid/_workitems/edit/1234')
  })

  it('rebuilds the share with the Bug link at the end', async () => {
    const res = await sendAdoReport({ prepared: await prep(), dest, pat: PAT })
    expect(res.share.text.split('\n').pop()).toBe('Bug #1234: https://dev.azure.com/acme/guid/_workitems/edit/1234')
    expect(res.share.html).toContain('href="https://dev.azure.com/acme/guid/_workitems/edit/1234"')
    expect(res.share.html).toContain('>Bug #1234<')
  })

  it('attaches the raw gz with a note when the player was unavailable', async () => {
    playerOk = false
    bundle.ok = false
    await sendAdoReport({ prepared: await prep(), dest, pat: PAT })
    const create = calls.find((c) => c.url.includes('/wit/workitems/$Bug'))!
    expect(String(create.body)).toContain('Replay recording attached (open with the Dalil player)')
    expect(calls.some((c) => c.url.includes('replay-20261012-083000.json.gz'))).toBe(true)
  })

  it('maps API failures to fixed codes', async () => {
    createStatus = 401
    await expect(sendAdoReport({ prepared: await prep(), dest, pat: PAT })).rejects.toMatchObject({ code: 'auth' })
    createStatus = 403
    await expect(sendAdoReport({ prepared: await prep(), dest, pat: PAT })).rejects.toMatchObject({ code: 'forbidden' })
    netDown = true
    await expect(sendAdoReport({ prepared: await prep(), dest, pat: PAT })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('never records Dalil\'s own Azure DevOps calls as request events', async () => {
    // the recorder patched window.fetch in init(); the widget must go around it
    const patched = window.fetch
    const p = await prep()
    await sendAdoReport({ prepared: p, dest, pat: PAT })
    expect(window.fetch).toBe(patched)
    expect(calls.some((c) => c.url.includes('dev.azure.com'))).toBe(true)
    expect(snapshot().events.filter((e) => e.type === 'request')).toHaveLength(0)
  })

  it('never lets the PAT or its Basic value reach the payload, share, zip or console', async () => {
    const p = await prep()
    const res = await sendAdoReport({ prepared: p, dest, pat: PAT })
    const zip = new Uint8Array(await (await buildEvidenceZip(p)).arrayBuffer())
    const hay = [JSON.stringify(p.payload), p.share.html, p.share.text, res.share.html, res.share.text, new TextDecoder('latin1').decode(zip), JSON.stringify(logs)]
    for (const h of hay) {
      expect(h).not.toContain(PAT)
      expect(h).not.toContain(BASIC)
    }
  })
})

describe('buildEvidenceZip', () => {
  it('contains the specified files with correct CRCs', async () => {
    const z = new Uint8Array(await (await buildEvidenceZip(await prep())).arrayBuffer())
    const v = new DataView(z.buffer)
    const end = z.length - 22
    const count = v.getUint16(end + 10, true)
    let p = v.getUint32(end + 16, true)
    const names: string[] = []
    for (let i = 0; i < count; i++) {
      const crc = v.getUint32(p + 16, true)
      const size = v.getUint32(p + 24, true)
      const nl = v.getUint16(p + 28, true)
      const off = v.getUint32(p + 42, true)
      const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nl))
      const start = off + 30 + v.getUint16(off + 26, true)
      expect(crc32(z.subarray(start, start + size))).toBe(crc)
      names.push(name)
      p += 46 + nl
    }
    expect(names).toEqual(['report.txt', 'report.html', 'screenshot-1.jpg', 'screenshot-2.png', 'auto-1-post-payment-create-500.jpg', 'replay.html', 'report.json'])
  })
})
