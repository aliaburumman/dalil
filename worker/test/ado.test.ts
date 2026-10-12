import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccessCache } from '../src/access'
import { PICK_TARGET_JS } from '../src/page'
import { evidenceUrl } from '../src/util'
import { ACCESS_VARS, accessHeaders, BASE, call, certsResponse, form, ingestRequest, JPEG, payload, seed, testEnv } from './helpers'

const ADO = { ADO_ORG: 'my org', ADO_PROJECT: 'Proj', ADO_PAT: 'secret-pat' }
const ADO_URL = 'https://dev.azure.com/my%20org/Proj/_apis/wit/workitems/$Bug?api-version=7.1'
const WI = 'https://dev.azure.com/my%20org/Proj/_workitems/edit/42'
let ado: ReturnType<typeof vi.fn<(init?: RequestInit) => Response>>
let att: ReturnType<typeof vi.fn<(init: RequestInit, url: string) => Response | Promise<Response>>>
const ATT = 'https://dev.azure.com/my%20org/Proj/_apis/wit/attachments?fileName='
let id: string
let ref = ''

const vars = (extra = {}) => testEnv({ ...ACCESS_VARS, ...extra })
async function post(path: string, headers: Record<string, string> | null, e = vars(ADO)) {
  return call(new Request(`${BASE}${path}`, { method: 'POST', body: new URLSearchParams(), headers: headers ?? {} }), e)
}
const page = async (e = vars(ADO)) => (await call(new Request(`${BASE}/r/${id}`, { headers: await accessHeaders() }), e)).text()
const row = () => env.DB.prepare('SELECT workitem_url FROM reports WHERE id = ?').bind(id).first<{ workitem_url: string | null }>()

beforeEach(async () => {
  resetAccessCache()
  await seed()
  ado = vi.fn<(init?: RequestInit) => Response>()
  att = vi.fn<(init: RequestInit, url: string) => Response | Promise<Response>>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const certs = await certsResponse(url)
    if (certs) return certs
    if (url === ADO_URL) return ado(init)
    if (url.startsWith(ATT)) return att(init!, url)
    if (url === 'https://api.resend.com/emails') return Response.json({ id: 'x' })
    throw new Error(`unexpected fetch ${url}`)
  })
  const res = await call(ingestRequest(form(payload())), testEnv())
  id = ((await res.json()) as { id: string }).id
})
afterEach(() => vi.restoreAllMocks())

const ok = () => Response.json({ id: 42, _links: { html: { href: WI } } })

describe('Azure DevOps work item', () => {
  it('disabled: no button and POST is 404', async () => {
    const off = vars({ ADO_ORG: 'o', ADO_PROJECT: 'p' }) // no PAT
    expect(await page(off)).not.toContain('Create work item')
    expect((await post(`/r/${id}/workitem`, await accessHeaders(), off)).status).toBe(404)
    expect(ado).not.toHaveBeenCalled()
  })

  it('enabled: shows the button, creates the item, stores and links it', async () => {
    ado.mockReturnValue(ok())
    expect(await page()).toContain('Create work item')
    const res = await post(`/r/${id}/workitem`, await accessHeaders())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/r/${id}`)
    expect((await row())!.workitem_url).toBe(WI)
    const html = await page()
    expect(html).toContain(`href="${WI}"`)
    expect(html).toContain('Work item')
    expect(html).not.toContain('Create work item')

    const init = ado.mock.calls[0]![0] as RequestInit
    const h = new Headers(init.headers)
    expect(h.get('content-type')).toBe('application/json-patch+json')
    expect(h.get('authorization')).toBe(`Basic ${btoa(':secret-pat')}`)
    const ops = JSON.parse(init.body as string)
    expect(ops[0]).toMatchObject({ op: 'add', path: '/fields/System.Title' })
    expect(ops[0].value).toContain("can't save payment")
    expect(ops[1]).toMatchObject({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps' })
    expect(ops[1].value).toContain('<ol>')
    expect(ops[2]).toEqual({ op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: `${env.PUBLIC_BASE}/r/${id}`, attributes: { comment: 'Dalil report' } } })
  })

  it('honours the type and body field vars', async () => {
    ado.mockReturnValue(ok())
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const certs = await certsResponse(url)
      if (certs) return certs
      if (url.startsWith(ATT)) return Response.json({ url: 'https://dev.azure.com/att/x.jpg' })
      expect(url).toBe('https://dev.azure.com/my%20org/Proj/_apis/wit/workitems/$Issue?api-version=7.1')
      expect(JSON.parse(init!.body as string)[1].path).toBe('/fields/System.Description')
      return ok()
    })
    const e = vars({ ...ADO, ADO_WORK_ITEM_TYPE: 'Issue', ADO_BODY_FIELD: 'System.Description' })
    expect((await post(`/r/${id}/workitem`, await accessHeaders(), e)).status).toBe(303)
    expect((await row())!.workitem_url).toBe(WI)
  })

  it('ADO 401: resets to NULL, redirects with wi_error, button returns', async () => {
    ado.mockReturnValue(new Response('no', { status: 401 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(`/r/${id}/workitem`, await accessHeaders())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/r/${id}?wi_error=auth`)
    expect((await row())!.workitem_url).toBeNull()
    const html = await (await call(new Request(`${BASE}/r/${id}?wi_error=auth`, { headers: await accessHeaders() }), vars(ADO))).text()
    expect(html).toContain('rejected the access token')
    expect(html).toContain('Create work item')
    const junk = await (await call(new Request(`${BASE}/r/${id}?wi_error=<script>x`, { headers: await accessHeaders() }), vars(ADO))).text()
    expect(junk).not.toContain('<script>x')
    expect(junk).not.toContain('role="alert"')
  })

  it('network failure resets and redirects', async () => {
    ado.mockImplementation(() => {
      throw new Error('down')
    })
    const res = await post(`/r/${id}/workitem`, await accessHeaders())
    expect(res.headers.get('location')).toBe(`/r/${id}?wi_error=unavailable`)
    expect((await row())!.workitem_url).toBeNull()
  })

  it('double POST makes exactly one ADO call', async () => {
    ado.mockReturnValue(ok())
    const h = await accessHeaders()
    const [a, b] = await Promise.all([post(`/r/${id}/workitem`, h), post(`/r/${id}/workitem`, h)])
    expect([a.status, b.status]).toEqual([303, 303])
    expect(ado).toHaveBeenCalledTimes(1)
    await post(`/r/${id}/workitem`, h)
    expect(ado).toHaveBeenCalledTimes(1)
  })

  it('stale pending is reclaimable (one ADO call); fresh pending blocks', async () => {
    ado.mockReturnValue(ok())
    const h = await accessHeaders()
    await env.DB.prepare('UPDATE reports SET workitem_url = ? WHERE id = ?').bind(`pending:${Date.now() - 10_000}`, id).run()
    expect(await page()).toContain('Creating work item')
    await post(`/r/${id}/workitem`, h)
    expect(ado).not.toHaveBeenCalled()
    await env.DB.prepare('UPDATE reports SET workitem_url = ? WHERE id = ?').bind(`pending:${Date.now() - 121_000}`, id).run()
    expect(await page()).toContain('Create work item')
    await post(`/r/${id}/workitem`, h)
    expect(ado).toHaveBeenCalledTimes(1)
    expect((await row())!.workitem_url).toBe(WI)
  })

  it('pending shows "Creating work item"', async () => {
    await env.DB.prepare('UPDATE reports SET workitem_url = ? WHERE id = ?').bind(`pending:${Date.now()}`, id).run()
    const html = await page()
    expect(html).toContain('Creating work item')
    expect(html).not.toContain('Create work item')
  })

  it('foreign Origin is 403, unauthenticated is 403, unknown report is 404', async () => {
    const h = await accessHeaders()
    expect((await post(`/r/${id}/workitem`, { ...h, origin: 'https://evil.test' })).status).toBe(403)
    expect((await post(`/r/${id}/workitem`, null)).status).toBe(403)
    expect((await post(`/r/00000000-0000-0000-0000-000000000000/workitem`, h)).status).toBe(404)
    expect(ado).not.toHaveBeenCalled()
    expect((await row())!.workitem_url).toBeNull()
  })
})

// ---- screenshots + replay in the Bug ----------------------------------------------------------
async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}
const JPG = (n: number) => {
  const b = new Uint8Array(JPEG.length + n)
  b.set(JPEG)
  return b
}
/** Ingests a v2 report: 1 screenshot, `autos` auto snaps, optional replay. Sets `id`. */
async function ingestMedia(opts: { autos?: number; replay?: boolean; screenshot?: boolean; labels?: string[] } = {}) {
  const autos = opts.autos ?? 2
  const labels = opts.labels ?? ['POST /api/bookings → 500', 'Error toast: <b>Failed</b> & "x"', 'TypeError: boom']
  const parts: Record<string, { bytes: Uint8Array; type: string }> = {}
  const images: { part: string; kind: 'screenshot' | 'auto'; name: string }[] = []
  if (opts.screenshot !== false) {
    parts.image_0 = { bytes: JPG(0), type: 'image/jpeg' }
    images.push({ part: 'image_0', kind: 'screenshot', name: 'screenshot.jpg' })
  }
  const autoSnaps = []
  for (let i = 0; i < autos; i++) {
    parts[`auto_${i}`] = { bytes: JPG(i + 1), type: 'image/jpeg' }
    images.push({ part: `auto_${i}`, kind: 'auto', name: `a${i}.jpg` })
    autoSnaps.push({ part: `auto_${i}`, t: Date.now() - 1000 * (i + 1), reason: 'request', label: labels[i]! })
  }
  if (opts.replay) parts.replay = { bytes: await gzip('[{"type":4,"timestamp":1,"data":{}}]'), type: 'application/gzip' }
  const p = payload({ v: 2, images, autoSnaps, ...(opts.replay ? { replay: { part: 'replay', durationMs: 42_000, events: 1, bytes: 1, rrweb: '2.0.0' } } : {}) } as never)
  const res = await call(ingestRequest(form(p, parts)), testEnv())
  expect(res.status).toBe(201)
  const out = (await res.json()) as { id: string; ref: string }
  id = out.id
  ref = out.ref
}
const attOk = (_i: RequestInit, url: string) => Response.json({ id: 'a', url: `https://dev.azure.com/att/${decodeURIComponent(url.slice(ATT.length).split('&')[0]!)}` })
const sentOps = () => JSON.parse((ado.mock.calls[0]![0] as RequestInit).body as string) as { op: string; path: string; value: unknown }[]
const bodyOf = () => sentOps()[1]!.value as string
const rels = () => sentOps().filter((o) => o.path === '/relations/-').map((o) => o.value as { rel: string; url: string })

describe('Azure DevOps media', () => {
  it('uploads 1 screenshot + 2 autos as octet-stream and embeds them with AttachedFile relations', async () => {
    await ingestMedia()
    att.mockImplementation(attOk)
    ado.mockReturnValue(ok())
    const res = await post(`/r/${id}/workitem`, await accessHeaders())
    expect(res.headers.get('location')).toBe(`/r/${id}`)
    expect(att).toHaveBeenCalledTimes(3)
    for (const [init, url] of att.mock.calls) {
      expect(init.method).toBe('POST')
      const h = new Headers(init.headers)
      expect(h.get('content-type')).toBe('application/octet-stream')
      expect(h.get('authorization')).toBe(`Basic ${btoa(':secret-pat')}`)
      expect(init.body).toBeInstanceOf(ArrayBuffer)
      expect(url).toContain('&api-version=7.1')
    }
    expect(att.mock.calls.map((c) => c[1].slice(ATT.length).split('&')[0])).toEqual([
      `${ref}-screenshot-1.jpg`,
      `${ref}-auto-1-post-api-bookings-500.jpg`,
      `${ref}-auto-2-error-toast-b-failed-b-x.jpg`,
    ])
    const body = bodyOf()
    expect(body).toContain('<p><b>Screenshots</b></p>')
    expect([...body.matchAll(/<img src="https:\/\/dev\.azure\.com\/att\//g)]).toHaveLength(3)
    expect(body).toContain('alt="Screenshot 1" style="max-width:100%"')
    expect(body).toContain('Auto: POST /api/bookings \u2192 500')
    // labels are escaped
    expect(body).toContain('Auto: Error toast: &lt;b&gt;Failed&lt;/b&gt; &amp; &quot;x&quot;')
    expect(body).not.toContain('<b>Failed</b>')
    expect(rels().filter((r) => r.rel === 'AttachedFile')).toHaveLength(3)
    expect(rels()[0]!.rel).toBe('Hyperlink')
  })

  it('one upload 500: Bug still created with a missing-image line and 2 relations', async () => {
    await ingestMedia()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    att.mockImplementation((i, url) => (url.includes('auto-1') ? new Response('x', { status: 500 }) : attOk(i, url)))
    ado.mockReturnValue(ok())
    expect((await post(`/r/${id}/workitem`, await accessHeaders())).headers.get('location')).toBe(`/r/${id}`)
    expect(bodyOf()).toContain("1 image couldn't be attached, see the report")
    expect(rels().filter((r) => r.rel === 'AttachedFile')).toHaveLength(2)
    expect((await row())!.workitem_url).toBe(WI)
  })

  it('all uploads 401: no Bug call, claim reset, wi_error=auth', async () => {
    await ingestMedia()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    att.mockReturnValue(new Response('no', { status: 401 }))
    const res = await post(`/r/${id}/workitem`, await accessHeaders())
    expect(res.headers.get('location')).toBe(`/r/${id}?wi_error=auth`)
    expect(ado).not.toHaveBeenCalled()
    expect((await row())!.workitem_url).toBeNull()
  })

  it('no replay: no replay block; replay: link ends with ?play=failure with m:ss duration, Hyperlink stays plain', async () => {
    await ingestMedia({ replay: false })
    att.mockImplementation(attOk)
    ado.mockReturnValue(ok())
    await post(`/r/${id}/workitem`, await accessHeaders())
    expect(bodyOf()).not.toContain('Watch replay')
    expect(bodyOf()).not.toContain('play=failure')

    ado.mockClear()
    await ingestMedia({ replay: true })
    await post(`/r/${id}/workitem`, await accessHeaders())
    const body = bodyOf()
    expect(body).toContain(`<a href="${env.PUBLIC_BASE}/r/${id}?play=failure"><img src="https://dev.azure.com/att/${ref}-screenshot-1.jpg" alt="" width="320"><br>\u25B6 Watch replay (0:42), jumps to the error</a>`)
    expect(rels()[0]).toEqual({ rel: 'Hyperlink', url: `${env.PUBLIC_BASE}/r/${id}`, attributes: { comment: 'Dalil report' } })
  })

  it('zero images: no Screenshots section and no uploads', async () => {
    await ingestMedia({ autos: 0, screenshot: false })
    ado.mockReturnValue(ok())
    expect((await post(`/r/${id}/workitem`, await accessHeaders())).headers.get('location')).toBe(`/r/${id}`)
    expect(att).not.toHaveBeenCalled()
    expect(bodyOf()).not.toContain('Screenshots')
    expect(rels()).toHaveLength(1)
  })

  it('report.json missing: Bug created without media or replay block', async () => {
    await ingestMedia({ replay: true })
    const prefix = (await env.DB.prepare('SELECT r2_prefix FROM reports WHERE id = ?').bind(id).first<{ r2_prefix: string }>())!.r2_prefix
    await env.BUCKET.delete(`${prefix}report.json`)
    ado.mockReturnValue(ok())
    expect((await post(`/r/${id}/workitem`, await accessHeaders())).headers.get('location')).toBe(`/r/${id}`)
    expect(att).not.toHaveBeenCalled()
    expect(bodyOf()).not.toContain('<img')
    expect(bodyOf()).not.toContain('Watch replay')
    expect((await row())!.workitem_url).toBe(WI)
  })

  it('keeps report order when uploads resolve out of order', async () => {
    await ingestMedia({ autos: 3 })
    const delay: Record<string, number> = { 'screenshot-1': 60, 'auto-1': 40, 'auto-2': 20, 'auto-3': 0 }
    att.mockImplementation(async (i, url) => {
      const name = decodeURIComponent(url.slice(ATT.length).split('&')[0]!)
      await new Promise((r) => setTimeout(r, delay[/(screenshot-1|auto-\d)/.exec(name)![1]!]))
      return attOk(i, url)
    })
    ado.mockReturnValue(ok())
    await post(`/r/${id}/workitem`, await accessHeaders())
    const srcs = [...bodyOf().matchAll(/<img src="[^"]+\/([^"/]+)\.jpg"/g)].map((m) => m[1]!.slice(ref.length + 1))
    expect(srcs).toEqual(['screenshot-1', 'auto-1-post-api-bookings-500', 'auto-2-error-toast-b-failed-b-x', 'auto-3-typeerror-boom'])
    expect(rels().filter((r) => r.rel === 'AttachedFile').map((r) => r.url.split('/').pop())).toEqual(srcs.map((x) => `${ref}-${x}.jpg`))
  })
})

describe('evidenceUrl and seek target', () => {
  it('adds ?play=failure only when the report has a replay', () => {
    expect(evidenceUrl('https://d.test', 'abc', true)).toBe('https://d.test/r/abc?play=failure')
    expect(evidenceUrl('https://d.test', 'abc', 1)).toBe('https://d.test/r/abc?play=failure')
    expect(evidenceUrl('https://d.test', 'abc', false)).toBe('https://d.test/r/abc')
    expect(evidenceUrl('https://d.test', 'abc', 0)).toBe('https://d.test/r/abc')
  })

  it('pickTarget: evidence id beats an earlier toast, then request/error, then first mark, then null', () => {
    const pick = new Function(`${PICK_TARGET_JS}; return pickTarget`)() as (m: unknown[], ev: string) => { timestamp: number } | null
    const mk = (timestamp: number, kind: string, eventId?: string) => ({ timestamp, data: { tag: 'dalil', payload: { kind, eventId } } })
    const toast = mk(1000, 'toast', 't1')
    const req = mk(3000, 'request', 'e3')
    const err = mk(2000, 'error', 'e2')
    expect(pick([toast, err, req], 'e3')).toBe(req)
    expect(pick([toast, req, err], 'nope')).toBe(req)
    expect(pick([toast, req], '')).toBe(req)
    expect(pick([toast, mk(5000, 'click')], '')).toBe(toast)
    expect(pick([], 'e3')).toBeNull()
  })
})
