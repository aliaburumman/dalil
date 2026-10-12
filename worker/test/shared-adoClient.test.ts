import { describe, expect, it, vi } from 'vitest'
import { AdoError, basicAuth, createWorkItem, listWorkItemTypes, uploadAttachment, type AdoContext } from '../../shared/adoClient'

const share = { title: 'DL-1: x', html: '<p>hi</p>', text: 'hi' }
const mk = (res: () => Response | Promise<Response>) => {
  const f = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => res())
  const ctx: AdoContext = { fetch: f as unknown as typeof fetch, org: 'o r', project: 'P', authHeader: basicAuth('pät-秘密-secret') }
  return { f, ctx }
}
const codeOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as AdoError)

describe('basicAuth', () => {
  it('does not throw on non-Latin1 and decodes back', () => {
    const h = basicAuth('pät-秘密')
    expect(h.startsWith('Basic ')).toBe(true)
    const bin = atob(h.slice(6))
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    expect(decoded).toBe(':pät-秘密')
  })
})

describe('createWorkItem', () => {
  it('builds json-patch with tags, areaPath and hyperlink', async () => {
    const { f, ctx } = mk(() => Response.json({ id: 7 }))
    const url = await createWorkItem(ctx, share, { hyperlink: 'https://t/r/1', tags: ['dalil', 'ui'], areaPath: 'P\\Web' })
    expect(url).toBe('https://dev.azure.com/o%20r/P/_workitems/edit/7')
    const [endpoint, init] = f.mock.calls[0]!
    expect(String(endpoint)).toBe('https://dev.azure.com/o%20r/P/_apis/wit/workitems/$Bug?api-version=7.1')
    const patch = JSON.parse(String(init!.body)) as Array<{ path: string; value: unknown }>
    expect(patch.find((p) => p.path === '/fields/System.Tags')!.value).toBe('dalil; ui')
    expect(patch.find((p) => p.path === '/fields/System.AreaPath')!.value).toBe('P\\Web')
    expect(patch.some((p) => p.path === '/relations/-')).toBe(true)
  })
  it('omits hyperlink, tags and areaPath when not provided', async () => {
    const { f, ctx } = mk(() => Response.json({ id: 7 }))
    await createWorkItem(ctx, share, {})
    const patch = JSON.parse(String(f.mock.calls[0]![1]!.body)) as Array<{ path: string }>
    expect(patch.map((p) => p.path)).toEqual(['/fields/System.Title', '/fields/Microsoft.VSTS.TCM.ReproSteps'])
  })
})

describe('listWorkItemTypes', () => {
  it('200 returns names', async () => {
    const { f, ctx } = mk(() => Response.json({ value: [{ name: 'Bug' }, { name: 'Task' }] }))
    expect(await listWorkItemTypes(ctx)).toEqual(['Bug', 'Task'])
    expect(String(f.mock.calls[0]![0])).toBe('https://dev.azure.com/o%20r/P/_apis/wit/workitemtypes?api-version=7.1')
  })
  it.each([[401, 'auth'], [403, 'forbidden'], [404, 'notfound'], [400, 'rejected'], [503, 'unavailable']])('%i -> %s', async (status, code) => {
    const { ctx } = mk(() => new Response('x', { status }))
    expect((await codeOf(listWorkItemTypes(ctx))).code).toBe(code)
  })
  it('network failure -> unavailable', async () => {
    const { ctx } = mk(() => { throw new TypeError('boom') })
    expect((await codeOf(listWorkItemTypes(ctx))).code).toBe('unavailable')
  })
})

describe('errors', () => {
  it('carry no PAT, header or body', async () => {
    const { ctx } = mk(() => new Response('{"leak":"secret"}', { status: 403 }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const errs = [await codeOf(createWorkItem(ctx, share, {})), await codeOf(uploadAttachment(ctx, new Uint8Array([1]), 'a.png'))]
    for (const e of errs) {
      const dump = JSON.stringify(e, Object.getOwnPropertyNames(e)) + e.message + String(e.stack ?? '').split('\n')[0]
      expect(e.code).toBe('forbidden')
      expect(dump).not.toMatch(/secret|Basic|pät|leak/)
    }
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/secret|Basic|leak/)
    spy.mockRestore()
  })
})
