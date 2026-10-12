import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccessCache } from '../src/access'
import { ACCESS_VARS, accessHeaders, BASE, call, certsResponse, form, ingestRequest, payload, seed, testEnv } from './helpers'

const ADO = { ADO_ORG: 'my org', ADO_PROJECT: 'Proj', ADO_PAT: 'secret-pat' }
const ADO_URL = 'https://dev.azure.com/my%20org/Proj/_apis/wit/workitems/$Bug?api-version=7.1'
const WI = 'https://dev.azure.com/my%20org/Proj/_workitems/edit/42'
let ado: ReturnType<typeof vi.fn<(init?: RequestInit) => Response>>
let id: string

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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const certs = await certsResponse(url)
    if (certs) return certs
    if (url === ADO_URL) return ado(init)
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
