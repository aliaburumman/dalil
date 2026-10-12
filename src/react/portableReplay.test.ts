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
  it('fetches js + css from playerUrl with the original fetch', async () => {
    const urls: string[] = []
    window.fetch = vi.fn(async (u: RequestInfo | URL) => {
      urls.push(String(u))
      return new Response(String(u).endsWith('.js') ? 'JS' : 'CSS')
    }) as unknown as typeof fetch
    const got = await loadPlayerAssets('https://cdn.test/dalil')
    expect(got).toEqual({ js: 'JS', css: 'CSS' })
    expect(urls.sort()).toEqual(['https://cdn.test/dalil/rrweb-player.2.1.7.css', 'https://cdn.test/dalil/rrweb-player.2.1.7.js'])
  })

  it('returns null when the player cannot be loaded', async () => {
    window.fetch = vi.fn(async () => {
      throw new TypeError('blocked by CSP')
    }) as unknown as typeof fetch
    expect(await loadPlayerAssets('https://nowhere.test/x/')).toBeNull()
  })
})
