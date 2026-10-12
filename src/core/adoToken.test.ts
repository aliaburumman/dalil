import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetTokensForTests, forgetToken, getToken, saveToken } from './adoToken'
import { __resetForTests } from './recorder'

let status: number
let calls: { url: string; auth: string }[]

beforeEach(() => {
  status = 200
  calls = []
  window.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization! })
    return new Response(JSON.stringify({ value: [{ name: 'Bug' }] }), { status })
  }) as unknown as typeof fetch
})

afterEach(async () => {
  await forgetToken('acme')
  __resetTokensForTests()
  __resetForTests()
  vi.restoreAllMocks()
})

describe('adoToken', () => {
  it('validates against the project, then saves and reads back', async () => {
    expect(await getToken('acme')).toBeNull()
    const res = await saveToken('acme', 'Web App', 'pat-1')
    expect(res.persisted).toBe(true)
    expect(calls[0]!.url).toBe('https://dev.azure.com/acme/Web%20App/_apis/wit/workitemtypes?api-version=7.1')
    expect(calls[0]!.auth).toBe('Basic ' + btoa(':pat-1'))
    expect(await getToken('acme')).toBe('pat-1')
  })

  it('uses its own database, not the pending-report one', async () => {
    await saveToken('acme', 'p', 'pat-1')
    const names = (await indexedDB.databases()).map((d) => d.name)
    expect(names).toContain('dalil-ado')
    expect(names).not.toContain('dalil')
  })

  it('does not save a rejected token (401 -> auth, 403 -> forbidden, 404 -> notfound)', async () => {
    for (const [s, code] of [[401, 'auth'], [403, 'forbidden'], [404, 'notfound']] as const) {
      status = s
      await expect(saveToken('acme', 'p', 'bad')).rejects.toMatchObject({ code })
      expect(await getToken('acme')).toBeNull()
    }
  })

  it('maps a network failure to unavailable', async () => {
    window.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(saveToken('acme', 'p', 'pat')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('forget removes it', async () => {
    await saveToken('acme', 'p', 'pat-1')
    await forgetToken('acme')
    expect(await getToken('acme')).toBeNull()
  })

  it('keeps it in memory for the session when IndexedDB is unavailable', async () => {
    const real = globalThis.indexedDB
    // @ts-expect-error simulate a browser without IndexedDB
    globalThis.indexedDB = undefined
    try {
      const res = await saveToken('acme', 'p', 'pat-mem')
      expect(res.persisted).toBe(false)
      expect(await getToken('acme')).toBe('pat-mem')
      await forgetToken('acme')
      expect(await getToken('acme')).toBeNull()
    } finally {
      globalThis.indexedDB = real
    }
  })

  it('keys tokens per org', async () => {
    await saveToken('acme', 'p', 'pat-a')
    expect(await getToken('other')).toBeNull()
  })
})
