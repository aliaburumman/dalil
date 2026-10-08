import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportRow } from '../src/env'
import worker from '../src/index'
import { BASE, call, form, ingestRequest, JPEG, ORIGIN, PNG, payload, seed, testEnv } from './helpers'

type ResendBody = { from: string; to: string[]; subject: string; html: string; attachments?: { filename: string; content: string; content_id?: string }[] }

let resendCalls: ResendBody[] = []
let resendStatus = 200

beforeEach(async () => {
  await seed()
  resendCalls = []
  resendStatus = 200
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`)
    resendCalls.push(JSON.parse(String(init?.body)) as ResendBody)
    return new Response(resendStatus === 200 ? '{"id":"email_1"}' : '{"message":"boom"}', { status: resendStatus })
  })
})
afterEach(() => vi.restoreAllMocks())

const row = (id: string) => env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>()

describe('CORS preflight', () => {
  const preflight = (origin: string, query = '') =>
    call(new Request(`${BASE}/v1/reports${query}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-dalil-key,x-dalil-project' } }))

  it('answers an allowed origin', async () => {
    const res = await preflight(ORIGIN)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-headers')).toContain('x-dalil-key')
  })
  it('denies an unknown origin', async () => {
    const res = await preflight('https://evil.test')
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('scopes to ?project= when given', async () => {
    expect((await preflight(ORIGIN, '?project=space')).status).toBe(204)
    expect((await preflight(ORIGIN, '?project=kings')).status).toBe(403)
  })
})

describe('POST /v1/reports guards', () => {
  it('rejects a bad key with 401', async () => {
    const res = await call(ingestRequest(form(payload()), { 'x-dalil-key': 'nope' }))
    expect(res.status).toBe(401)
  })
  it('rejects a wrong origin with 403', async () => {
    const res = await call(ingestRequest(form(payload()), { origin: 'https://portal.kings.test' }))
    expect(res.status).toBe(403)
  })
  it('rejects a body over 8 MB with 413', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 10)
    big.set(JPEG.subarray(0, 4))
    const res = await call(ingestRequest(form(payload(), { image_0: { bytes: big, type: 'image/jpeg' } })))
    expect(res.status).toBe(413)
  })
  it('rejects more than 6 images with 400', async () => {
    const f = form(payload(), {})
    for (let i = 0; i < 7; i++) f.append(i < 6 ? `image_${i}` : 'image_5', new File([JPEG], 'x.jpg', { type: 'image/jpeg' }))
    const res = await call(ingestRequest(f))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('too many images')
  })
  it('rejects an unexpected part name and a non-image type', async () => {
    expect((await call(ingestRequest(form(payload(), { image_9: { bytes: JPEG, type: 'image/jpeg' } })))).status).toBe(400)
    expect((await call(ingestRequest(form(payload(), { image_0: { bytes: new TextEncoder().encode('<svg/>'), type: 'image/svg+xml' } })))).status).toBe(400)
  })
  it('rejects a report part over 1 MB with 413', async () => {
    const res = await call(ingestRequest(form(payload({ expected: 'x'.repeat(1024 * 1024) }))))
    expect(res.status).toBe(413)
  })
  it('rejects a wrong payload version with 400', async () => {
    const res = await call(ingestRequest(form({ ...payload(), v: 99 })))
    expect(res.status).toBe(400)
  })
  it('enforces the hourly D1 cap with 429', async () => {
    const ipHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('9.9.9.9')))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const stmts = Array.from({ length: 20 }, () => env.DB.prepare('INSERT INTO ingest_hits VALUES (?, ?, ?)').bind('space', ipHash, Date.now()))
    await env.DB.batch(stmts)
    const res = await call(ingestRequest(form(payload()), { 'cf-connecting-ip': '9.9.9.9' }))
    expect(res.status).toBe(429)
  })
})

describe('POST /v1/reports happy path', () => {
  it('allocates SPACE-1 then SPACE-2, writes R2 and the row', async () => {
    const r1 = await call(ingestRequest(form(payload(), { image_0: { bytes: JPEG, type: 'image/jpeg' }, image_1: { bytes: PNG, type: 'image/png' } })))
    expect(r1.status).toBe(201)
    expect(r1.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const b1 = (await r1.json()) as { id: string; ref: string; url: string }
    expect(b1.ref).toBe('SPACE-1')
    expect(b1.url).toBe(`${env.PUBLIC_BASE}/r/${b1.id}`)

    const r2 = await call(ingestRequest(form(payload())))
    const b2 = (await r2.json()) as { id: string; ref: string }
    expect(b2.ref).toBe('SPACE-2')

    const prefix = `reports/space/${b1.id}/`
    expect(await env.BUCKET.head(`${prefix}report.json`)).not.toBeNull()
    expect(await env.BUCKET.head(`${prefix}image_0`)).not.toBeNull()
    expect((await env.BUCKET.head(`${prefix}image_1`))?.httpMetadata?.contentType).toBe('image/png')

    const r = await row(b1.id)
    expect(r).toMatchObject({ project_id: 'space', seq: 1, status: 'new', verdict_kind: 'backend', severity: 'blocker', scrubbed: 0, r2_prefix: prefix })
    expect(JSON.parse(r!.request_ids!)).toEqual(['req-111'])
  })

  it('scrubs a JWT and a raw Bearer token server-side and flags the row', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'
    const p = payload({ title: `token ${jwt} leaked`, curls: { e3: `curl -H "Authorization: Bearer abc.def" -H "X: Bearer $TOKEN"` } })
    const res = await call(ingestRequest(form(p)))
    const { id } = (await res.json()) as { id: string }
    expect((await row(id))?.scrubbed).toBe(1)
    const stored = await (await env.BUCKET.get(`reports/space/${id}/report.json`))!.text()
    expect(stored).not.toContain(jwt)
    expect(stored).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/)
    expect(stored).not.toContain('abc.def')
    expect(stored).toContain('Bearer $TOKEN')
    expect(JSON.parse(stored).title).toBe('token [JWT] leaked')
  })

  it('deletes the row and returns 500 when R2 fails', async () => {
    const failing = {
      put: async () => {
        throw new Error('R2 down')
      },
      delete: (keys: string | string[]) => env.BUCKET.delete(keys),
    } as unknown as R2Bucket
    const res = await call(ingestRequest(form(payload())), testEnv({ BUCKET: failing }))
    expect(res.status).toBe(500)
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first<{ n: number }>())!
    expect(n).toBe(0)
    expect(resendCalls).toHaveLength(0)
  })
})

describe('email', () => {
  it('sends through Resend with an inline CID screenshot and marks sent', async () => {
    const res = await call(ingestRequest(form(payload(), { image_0: { bytes: JPEG, type: 'image/jpeg' }, image_1: { bytes: PNG, type: 'image/png' } })))
    const { id } = (await res.json()) as { id: string }
    expect((await row(id))?.email_status).toBe('sent')
    expect(resendCalls).toHaveLength(1)
    const mail = resendCalls[0]!
    expect(mail.to).toEqual(['dev@example.com'])
    expect(mail.subject).toBe(`[SPACE-1] Backend · Backend error: 500 on POST /Payment/Create · "can't save payment"`)
    expect(mail.html).toContain('cid:screenshot')
    expect(mail.html).toContain('Clicked <strong>Save payment</strong> on <em>Add Payment</em>')
    expect(mail.html).toContain('POST /Payment/Create</code> → <strong>500</strong>')
    expect(mail.html).toContain('req-111')
    expect(mail.html).toContain(`/r/${id}`)
    expect(mail.attachments?.[0]).toMatchObject({ content_id: 'screenshot' })
    expect(mail.attachments?.[1]?.content_id).toBeUndefined()
  })

  it('marks failed when Resend returns 500, and the cron retries it', async () => {
    resendStatus = 500
    const res = await call(ingestRequest(form(payload())))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect((await row(id))?.email_status).toBe('failed')

    resendStatus = 200
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '17 3 * * *' }), testEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect((await row(id))?.email_status).toBe('sent')
  })

  it('escapes user content in the email', async () => {
    await call(ingestRequest(form(payload({ title: '<img src=x onerror=alert(1)>' }))))
    expect(resendCalls[0]!.html).not.toContain('<img src=x')
    expect(resendCalls[0]!.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('report page', () => {
  it('renders and escapes a <script> title', async () => {
    const res = await call(ingestRequest(form(payload({ title: '<script>alert("x")</script>' }))))
    const { id } = (await res.json()) as { id: string }
    const page = await call(new Request(`${BASE}/r/${id}`))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('SPACE-1')
    expect(html).toContain('data-copy="curl-0"')
    expect(html).toContain(`/r/${id}/img/image_0`)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'nonce-")

    const img = await call(new Request(`${BASE}/r/${id}/img/image_0`))
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG)
    expect((await call(new Request(`${BASE}/r/${id}/img/report.json`))).status).toBe(404)
  })

  it('updates the status', async () => {
    const res = await call(ingestRequest(form(payload())))
    const { id } = (await res.json()) as { id: string }
    const body = new URLSearchParams({ status: 'fixed' })
    const upd = await call(new Request(`${BASE}/r/${id}/status`, { method: 'POST', body, headers: { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' } }))
    expect(upd.status).toBe(303)
    expect((await row(id))?.status).toBe('fixed')

    const bad = await call(new Request(`${BASE}/r/${id}/status`, { method: 'POST', body: new URLSearchParams({ status: 'deleted' }) }))
    expect(bad.status).toBe(400)
    const csrf = await call(new Request(`${BASE}/r/${id}/status`, { method: 'POST', body, headers: { origin: 'https://evil.test' } }))
    expect(csrf.status).toBe(403)
  })

  it('404s an unknown report', async () => {
    expect((await call(new Request(`${BASE}/r/00000000-0000-0000-0000-000000000000`))).status).toBe(404)
  })
})

describe('scheduled', () => {
  it('deletes rows older than 90 days and keeps recent ones', async () => {
    const day = 86_400_000
    const now = Date.now()
    const ins = (id: string, seq: number, created: number) =>
      env.DB.prepare(`INSERT INTO reports (id, project_id, seq, title, created_at, r2_prefix, email_status) VALUES (?, 'space', ?, 't', ?, 'x/', 'sent')`).bind(id, seq, created)
    await env.DB.batch([ins('old', 1, now - 91 * day), ins('new', 2, now - 89 * day)])
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '17 3 * * *' }), testEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect(await row('old')).toBeNull()
    expect(await row('new')).not.toBeNull()
  })
})


// ---- v0.2: replay + auto snapshots ----------------------------------------------------

async function gzip(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const PLAYER = (await import('../src/player-version')).PLAYER_VERSION
const jpegN = (n: number) => {
  const b = new Uint8Array(JPEG.length + n)
  b.set(JPEG)
  return b
}

function v2(over: Record<string, unknown> = {}) {
  const t = Date.now()
  return payload({
    v: 2,
    images: [
      { part: 'image_0', kind: 'screenshot', name: 'screenshot.jpg' },
      { part: 'auto_0', kind: 'auto', name: 'a0.jpg' },
      { part: 'auto_1', kind: 'auto', name: 'a1.jpg' },
      { part: 'auto_2', kind: 'auto', name: 'a2.jpg' },
    ],
    autoSnaps: [
      { part: 'auto_0', t: t - 3000, reason: 'request', label: 'POST /Payment/Create → 500' },
      { part: 'auto_1', t: t - 2000, reason: 'toast', label: 'Error toast: Failed to save payment' },
      { part: 'auto_2', t: t - 1000, reason: 'error', label: 'TypeError: boom' },
    ],
    replay: { part: 'replay', durationMs: 5000, events: 3, bytes: 1, rrweb: '2.0.0' },
    ...over,
  } as never)
}

const REPLAY_JSON = JSON.stringify([
  { type: 4, timestamp: 1000, data: {} },
  { type: 2, timestamp: 1001, data: {} },
  { type: 5, timestamp: 4000, data: { tag: 'dalil', payload: { kind: 'toast', label: 'Toast <b>x</b>' } } },
])

async function v2Form(replay: Uint8Array | null, extra: Record<string, { bytes: Uint8Array; type: string }> = {}, p: unknown = v2()) {
  const images: Record<string, { bytes: Uint8Array; type: string }> = {
    image_0: { bytes: JPEG, type: 'image/jpeg' },
    auto_0: { bytes: jpegN(10), type: 'image/jpeg' },
    auto_1: { bytes: jpegN(20), type: 'image/jpeg' },
    auto_2: { bytes: jpegN(30), type: 'image/jpeg' },
    ...extra,
  }
  if (replay) images.replay = { bytes: replay, type: 'application/gzip' }
  return form(p, images)
}

describe('v0.2 ingest', () => {
  it('still accepts a v1 payload', async () => {
    const res = await call(ingestRequest(form(payload({ v: 1 } as never))))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(await row(id)).toMatchObject({ has_replay: 0, auto_snaps: 0, replay_dropped: 0 })
  })

  it('stores v2 replay + 3 auto snaps and serves them', async () => {
    const gz = await gzip(REPLAY_JSON)
    const res = await call(ingestRequest(await v2Form(gz)))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(await row(id)).toMatchObject({ has_replay: 1, auto_snaps: 3, replay_dropped: 0 })
    const prefix = `reports/space/${id}/`
    expect(await env.BUCKET.head(`${prefix}replay.json.gz`)).not.toBeNull()
    expect(await env.BUCKET.head(`${prefix}auto_2.jpg`)).not.toBeNull()

    const r = await call(new Request(`${BASE}/r/${id}/replay`))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/gzip')
    expect(r.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(gz)

    const a = await call(new Request(`${BASE}/r/${id}/auto/1`))
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toBe('image/jpeg')
    expect((await call(new Request(`${BASE}/r/${id}/auto/3`))).status).toBe(404)
  })

  it('404s the replay route when there is none', async () => {
    const { id } = (await (await call(ingestRequest(form(payload())))).json()) as { id: string }
    expect((await call(new Request(`${BASE}/r/${id}/replay`))).status).toBe(404)
  })

  it('rejects a replay over the compressed cap with 413', async () => {
    const big = new Uint8Array(5_000_001)
    big[0] = 0x1f
    big[1] = 0x8b
    const res = await call(ingestRequest(await v2Form(big)))
    expect(res.status).toBe(413)
    expect(await res.text()).toContain('replay too large')
  })

  it('rejects a gzip bomb (decompresses over the cap) with 413', async () => {
    const bomb = await gzip(new Uint8Array(41_000_000))
    expect(bomb.byteLength).toBeLessThan(200_000)
    const res = await call(ingestRequest(await v2Form(bomb)))
    expect(res.status).toBe(413)
    expect(await res.text()).toContain('decompressed')
  })

  it('rejects a non-gzip replay with 400', async () => {
    const res = await call(ingestRequest(await v2Form(new TextEncoder().encode('{"events":[]}'))))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('gzip')
  })

  it('rejects an oversized auto snapshot with 413 and a 4th auto part with 400', async () => {
    expect((await call(ingestRequest(await v2Form(null, { auto_0: { bytes: jpegN(400_001), type: 'image/jpeg' } })))).status).toBe(413)
    const f = await v2Form(null)
    expect((await call(ingestRequest(f))).status).toBe(201)
    const g = await v2Form(null)
    g.append('auto_1', new File([JPEG], 'x.jpg', { type: 'image/jpeg' }))
    expect((await call(ingestRequest(g))).status).toBe(400)
  })

  it('drops the replay but keeps the report after 10 replay uploads per hour', async () => {
    const gz = await gzip(REPLAY_JSON)
    const ip = { 'cf-connecting-ip': '7.7.7.7' }
    for (let i = 0; i < 10; i++) {
      expect((await call(ingestRequest(await v2Form(gz), ip))).status).toBe(201)
    }
    const res = await call(ingestRequest(await v2Form(gz), ip))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(await row(id)).toMatchObject({ has_replay: 0, replay_dropped: 1, auto_snaps: 3 })
    expect(await env.BUCKET.head(`reports/space/${id}/replay.json.gz`)).toBeNull()
    const stored = JSON.parse(await (await env.BUCKET.get(`reports/space/${id}/report.json`))!.text())
    expect(stored.replay).toBeUndefined()
    expect(stored.replayError).toContain('hourly')
  })
})

describe('v0.2 report page', () => {
  it('sets the CSP, loads the vendored player, renders auto snaps, escapes labels', async () => {
    const p = v2({ autoSnaps: [{ part: 'auto_0', t: Date.now(), reason: 'toast', label: '<script>x</script>' }] })
    const { id } = (await (await call(ingestRequest(await v2Form(await gzip(REPLAY_JSON), {}, p)))).json()) as { id: string }
    const page = await call(new Request(`${BASE}/r/${id}`))
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]+' 'self'/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("img-src 'self' data: blob: https:")
    expect(csp).toContain("font-src 'self' data: https:")
    const html = await page.text()
    expect(html).toContain(`<script src="/assets/rrweb-player.${PLAYER}.js" nonce=`)
    expect(html).toContain(`/assets/rrweb-player.${PLAYER}.css`)
    expect(html).toContain('id="replay-box"')
    expect(html).toContain('Captured automatically')
    expect(html).toContain(`/r/${id}/auto/0`)
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('shows replayError when there is no replay', async () => {
    const p = v2({ replay: undefined, replayError: 'recording excluded by tester' })
    const { id } = (await (await call(ingestRequest(await v2Form(null, {}, p)))).json()) as { id: string }
    const html = await (await call(new Request(`${BASE}/r/${id}`))).text()
    expect(html).toContain('No recording: recording excluded by tester')
    expect(html).not.toContain('rrweb-player')
  })

  it('serves the vendored player assets', async () => {
    const js = await call(new Request(`${BASE}/assets/rrweb-player.${PLAYER}.js`))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type') ?? '').toMatch(/javascript/)
    expect((await js.text()).length).toBeGreaterThan(100_000)
    const css = await call(new Request(`${BASE}/assets/rrweb-player.${PLAYER}.css`))
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type') ?? '').toContain('css')
    expect((await call(new Request(`${BASE}/assets/other.js`))).status).toBe(404)
  })
})

describe('v0.2 email', () => {
  it('uses the newest auto snapshot as the hero and links the replay', async () => {
    await call(ingestRequest(await v2Form(await gzip(REPLAY_JSON))))
    const mail = resendCalls[0]!
    expect(mail.html).toContain('cid:autosnap')
    expect(mail.html).toContain('TypeError: boom') // newest by t is auto_2
    expect(mail.html).toContain('cid:screenshot')
    expect(mail.html).toContain('▶ Watch the last 2 minutes')
    expect(mail.html).toMatch(/\/r\/[0-9a-f-]+#replay/)
    const ids = mail.attachments!.map((a) => a.content_id).filter(Boolean)
    expect(ids).toEqual(['autosnap', 'screenshot'])
    expect(mail.attachments!.filter((a) => a.filename.startsWith('auto'))).toHaveLength(1)
  })

  it('falls back to the screenshot hero without auto snaps', async () => {
    await call(ingestRequest(form(payload())))
    expect(resendCalls[0]!.html).toContain('cid:screenshot')
    expect(resendCalls[0]!.html).not.toContain('cid:autosnap')
    expect(resendCalls[0]!.html).not.toContain('Watch the last')
  })
})
