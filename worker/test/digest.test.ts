import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportRow } from '../src/env'
import { resetAccessCache } from '../src/access'
import worker from '../src/index'
import { ACCESS_VARS, accessHeaders, BASE, call, certsResponse, form, ingestRequest, payload, seed, testEnv } from './helpers'

type Mail = { to: string[]; subject: string; html: string; attachments?: unknown }
let mails: Mail[] = []
let resendStatus = 200

beforeEach(async () => {
  resetAccessCache()
  await seed()
  mails = []
  resendStatus = 200
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const certs = await certsResponse(url)
    if (certs) return certs
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`)
    mails.push(JSON.parse(String(init?.body)) as Mail)
    return new Response(resendStatus === 200 ? '{"id":"e"}' : '{"message":"boom"}', { status: resendStatus })
  })
})
afterEach(() => vi.restoreAllMocks())

const DIGEST = '0 6,18 * * *'
const MAINT = '17 3 * * *'
const row = (id: string) => env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>()

async function cron(expr: string) {
  const ctx = createExecutionContext()
  await worker.scheduled(createScheduledController({ cron: expr }), testEnv(), ctx)
  await waitOnExecutionContext(ctx)
}

async function submit(over: Parameters<typeof payload>[0] = {}): Promise<string> {
  const res = await call(ingestRequest(form(payload({ severity: 'minor', ...over }))))
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

describe('ingest email modes', () => {
  it('queues a non-blocker for the digest and sends nothing now', async () => {
    const id = await submit()
    expect(mails).toHaveLength(0)
    const r = await row(id)
    expect(r?.email_status).toBe('digest')
    expect(r?.digested_at).toBeNull()
  })

  it('sends a blocker immediately and keeps it undigested', async () => {
    const id = await submit({ severity: 'blocker' })
    expect(mails).toHaveLength(1)
    const r = await row(id)
    expect(r?.email_status).toBe('sent')
    expect(r?.digested_at).toBeNull()
  })

  it("email_mode 'each' preserves the old per-report email", async () => {
    await env.DB.prepare(`UPDATE projects SET email_mode='each' WHERE id='space'`).run()
    const id = await submit({ severity: 'minor' })
    expect(mails).toHaveLength(1)
    expect(mails[0]!.subject).toContain('[SPACE-1]')
    expect((await row(id))?.email_status).toBe('sent')
  })

  it('stores verdict.userSaw for the digest', async () => {
    const id = await submit({ verdict: { kind: 'ux', headline: 'h', confidence: 'low', evidenceEventId: null, alsoSeen: [], userSaw: 'Spinner forever' } as never })
    expect((await row(id))?.user_saw).toBe('Spinner forever')
  })
})

describe('digest cron', () => {
  it('sends one email with only undigested rows and marks exactly those', async () => {
    const a = await submit({ title: 'first <b>one</b>', verdict: { kind: 'ux', headline: 'Slow', confidence: 'low', evidenceEventId: null, alsoSeen: [], userSaw: 'a "blank" page' } as never })
    const b = await submit({ severity: 'blocker' })
    await env.DB.prepare(`INSERT INTO reports (id, project_id, seq, title, created_at, r2_prefix, email_status, digested_at) VALUES ('old1','space',99,'old',1,'x/','sent',1)`).run()
    mails = []
    await cron(DIGEST)
    expect(mails).toHaveLength(1)
    const m = mails[0]!
    expect(m.subject).toBe('[Space] 12-hour bug digest — 2 reports (1 blockers)')
    expect(m.to).toEqual(['dev@example.com'])
    expect(m.html).toContain(`/r/${a}`)
    expect(m.html).toContain(`/r/${b}`)
    expect(m.html).not.toContain('/r/old1')
    expect(m.html).toContain('&lt;b&gt;one&lt;/b&gt;')
    expect(m.html).not.toContain('<b>one</b>')
    expect(m.html).toContain('User saw: "a &quot;blank&quot; page"')
    expect(m.html).toContain('already emailed')
    expect(m.html).toContain('Open reports page')
    expect(m.attachments).toBeUndefined()
    expect((await row(a))?.digested_at).not.toBeNull()
    expect((await row(b))?.digested_at).not.toBeNull()
    expect((await row(b))?.email_status).toBe('sent')
    // a second run has nothing to send
    mails = []
    await cron(DIGEST)
    expect(mails).toHaveLength(0)
  })

  it('sends nothing when there is nothing undigested', async () => {
    await cron(DIGEST)
    expect(mails).toHaveLength(0)
  })

  it('leaves rows undigested on failure so the next run retries', async () => {
    const a = await submit()
    resendStatus = 500
    await cron(DIGEST)
    expect((await row(a))?.digested_at).toBeNull()
    resendStatus = 200
    mails = []
    await cron(DIGEST)
    expect(mails).toHaveLength(1)
    expect((await row(a))?.digested_at).not.toBeNull()
  })

  it('skips projects without notify_emails and caps at 200 reports', async () => {
    const stmt = env.DB.prepare(`INSERT INTO reports (id, project_id, seq, title, severity, created_at, r2_prefix, email_status) VALUES (?, 'space', ?, 't', 'minor', ?, 'x/', 'digest')`)
    await env.DB.batch(Array.from({ length: 205 }, (_, i) => stmt.bind(`r${i}`, i + 1, 1000 + i)))
    await env.DB.prepare(`INSERT INTO reports (id, project_id, seq, title, severity, created_at, r2_prefix, email_status) VALUES ('k1','kings',1,'t','minor',5,'x/','digest')`).run()
    await cron(DIGEST)
    expect(mails).toHaveLength(1)
    expect(mails[0]!.html).toContain('+5 more, see the reports page')
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE project_id='space' AND digested_at IS NULL`).first<{ n: number }>()
    expect(left?.n).toBe(5)
    expect((await row('k1'))?.digested_at).toBeNull()
  })
})

describe('maintenance cron', () => {
  it("does not resend or retry 'digest' rows", async () => {
    const a = await submit()
    await cron(MAINT)
    expect(mails).toHaveLength(0)
    expect((await row(a))?.email_status).toBe('digest')
    expect((await row(a))?.digested_at).toBeNull()
  })
})

describe('reports list page', () => {
  const get = async (path: string, headers?: Record<string, string>) =>
    call(new Request(`${BASE}${path}`, { headers: headers ?? (await accessHeaders()) }), testEnv(ACCESS_VARS))

  it('is 403 without the Access header and 200 with it', async () => {
    for (const path of ['/', '/p/space']) {
      const no = await get(path, {})
      expect(no.status).toBe(403)
      expect(await no.text()).toContain('Protected: configure Cloudflare Access')
      const ok = await get(path)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('Signed in as ali@example.com')
    }
    expect((await get('/p/nope')).status).toBe(404)
  })

  async function seedMany() {
    const stmt = env.DB.prepare(
      `INSERT INTO reports (id, project_id, seq, title, verdict_kind, verdict_headline, severity, status, reporter, created_at, r2_prefix, has_replay, auto_snaps) VALUES (?, 'space', ?, ?, ?, 'H', ?, ?, '{"userName":"Ali","tenant":"BVB"}', ?, 'x/', ?, 2)`,
    )
    await env.DB.batch([
      ...Array.from({ length: 60 }, (_, i) => stmt.bind(`n${i}`, i + 1, `title ${i}`, 'backend', 'minor', 'new', 1000 + i, 1)),
      stmt.bind('f1', 100, 'fixed one', 'ux', 'blocker', 'fixed', 5000, 0),
      stmt.bind('x1', 101, '<script>alert(1)</script>', 'ux', 'annoying', 'seen', 4000, 0),
    ])
  }

  it('paginates newest first, 50 per page, and filters', async () => {
    await seedMany()
    const p1 = await (await get('/p/space')).text()
    expect(p1).toContain('page 1 of 2')
    expect(p1).toContain('/r/x1')
    expect(p1).not.toContain('/r/f1') // fixed hidden by default (open)
    expect(p1.indexOf('/r/x1')).toBeLessThan(p1.indexOf('/r/n59'))
    expect(p1.match(/<tr><td><a href="\/r\//g)).toHaveLength(50)
    const p2 = await (await get('/p/space?page=2')).text()
    expect(p2.match(/<tr><td><a href="\/r\//g)).toHaveLength(11)
    expect(await (await get('/p/space?status=fixed')).text()).toContain('/r/f1')
    const all = await (await get('/?status=all&severity=blocker')).text()
    expect(all).toContain('/r/f1')
    expect(all).not.toContain('/r/n1"')
    const kind = await (await get('/?status=all&kind=ux')).text()
    expect(kind).toContain('/r/f1')
    expect(kind).not.toContain('/r/n5"')
    expect(p1).toContain('SPACE-1')
    expect(p1).toContain('Ali · BVB')
  })

  it('escapes titles and ignores junk query values', async () => {
    await seedMany()
    const html = await (await get('/p/space?status=<x>&kind=evil&page=-3')).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
