import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetForTests } from '../core/recorder'
import { buildPortableReplay, FAILURE_LEAD_MS, loadPlayerAssets, PICK_TARGET_JS } from './portableReplay'

const pick = new Function(`${PICK_TARGET_JS}; return pickTarget`)() as (marks: unknown[], ev: string) => { id: string } | null
const mark = (id: string, kind: string, eventId?: string) => ({ id, data: { tag: 'dalil', payload: { kind, eventId } } })

const assets = { js: 'window.rrwebPlayer=function(){};/* </script> */', css: '.rr{color:red}/* </style> */' }
const gzBytes = new Uint8Array([0x1f, 0x8b, 8, 0, 9, 8, 7, 250, 251, 252])

afterEach(() => {
  __resetForTests()
  vi.restoreAllMocks()
})

describe('pickTarget (same source the page runs)', () => {
  it('prefers the evidence event, then request/error, then the first mark, else null', () => {
    const marks = [mark('a', 'toast'), mark('b', 'request', 'e1'), mark('c', 'error', 'e2')]
    expect(pick(marks, 'e2')!.id).toBe('c')
    expect(pick(marks, 'nope')!.id).toBe('b')
    expect(pick([mark('a', 'toast'), mark('d', 'log')], '')!.id).toBe('a')
    expect(pick([], '')).toBeNull()
  })
})

describe('buildPortableReplay', () => {
  it('is self-contained: player text, base64 recording, seek logic, title and duration', async () => {
    const html = await (await buildPortableReplay({
      gz: new Blob([gzBytes]),
      title: 'SPACE: <Save> broke',
      durationMs: 108_000,
      evidenceId: 'e2',
      assets,
    })).text()
    expect(html).toContain('window.rrwebPlayer=function(){}')
    expect(html).toContain('.rr{color:red}')
    expect(html).toContain(btoa(String.fromCharCode(...gzBytes)))
    expect(html).toContain('DecompressionStream')
    expect(html).toContain(`FAILURE_LEAD_MS=${FAILURE_LEAD_MS}`)
    expect(html).toContain('function pickTarget')
    expect(html).toContain('data-evidence="e2"')
    expect(html).toContain('<title>SPACE: &lt;Save&gt; broke</title>')
    expect(html).toContain('1:48')
    expect(html).toContain("tag==='dalil'")
    // inlined text cannot close its element early
    expect(html.match(/<\/script>/g)).toHaveLength(3)
    expect(html.match(/<\/style>/g)).toHaveLength(2)
    expect(FAILURE_LEAD_MS).toBe(5000)
  })
})

describe('loadPlayerAssets', () => {
  const js = 'window.rrwebPlayer=function(){}'
  const fetchWith = (fn: (u: string) => Response) =>
    (window.fetch = vi.fn(async (u: RequestInfo | URL) => fn(String(u))) as unknown as typeof fetch)

  it('fetches js + css from playerUrl with the original fetch', async () => {
    const urls: string[] = []
    fetchWith((u) => {
      urls.push(u)
      return new Response(u.endsWith('.js') ? js : '.rr{}')
    })
    const got = await loadPlayerAssets('https://cdn.test/dalil')
    expect(got).toEqual({ js, css: '.rr{}' })
    expect(urls.sort()).toEqual(['https://cdn.test/dalil/rrweb-player.2.1.7.css', 'https://cdn.test/dalil/rrweb-player.2.1.7.js'])
  })

  it('rejects an SPA fallback (HTML with status 200) and falls back to the bundled player', async () => {
    fetchWith(() => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }))
    const got = await loadPlayerAssets('https://spa.test/x/')
    expect(got!.js).toContain('rrwebPlayer')
    expect(got!.js.trimStart().startsWith('<')).toBe(false)
  })

  it('rejects html-looking bodies and JS without the player marker', async () => {
    fetchWith((u) => new Response(u.endsWith('.js') ? 'console.log(1)' : '.a{}'))
    expect((await loadPlayerAssets('https://x.test/a/'))!.js).toContain('rrwebPlayer')
    fetchWith((u) => new Response(u.endsWith('.js') ? js : '  <html>'))
    const got = await loadPlayerAssets('https://x.test/b/')
    expect(got!.css).not.toContain('<html>')
  })

  it('uses the bundled chunk when no playerUrl is given (ESM)', async () => {
    const f = fetchWith(() => new Response('nope', { status: 404 }))
    const got = await loadPlayerAssets()
    expect(got!.js).toContain('rrwebPlayer')
    expect(got!.css.length).toBeGreaterThan(100)
    expect(f).not.toHaveBeenCalled()
  })
})
