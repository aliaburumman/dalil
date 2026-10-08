import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import type { Env } from '../src/env'
import worker from '../src/index'
import { PAYLOAD_VERSION, type ReportPayload } from '../src/payload'

export const ORIGIN = 'https://portal.space.test'
export const KEY = 'pk_space_test'
export const BASE = 'https://dalil.test'

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    BUCKET: env.BUCKET,
    RATE_LIMITER: env.RATE_LIMITER,
    PUBLIC_BASE: env.PUBLIC_BASE,
    MAIL_FROM: env.MAIL_FROM,
    HOURLY_LIMIT: env.HOURLY_LIMIT,
    RESEND_API_KEY: env.RESEND_API_KEY,
    ...overrides,
  }
}

export async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reports'),
    env.DB.prepare('DELETE FROM ingest_hits'),
    env.DB.prepare('DELETE FROM projects'),
    env.DB.prepare(
      `INSERT INTO projects (id, name, public_key, allowed_origins, notify_emails, key_prefix, created_at)
       VALUES ('space', 'Space', ?, ?, '["dev@example.com"]', 'SPACE', 0),
              ('kings', 'Kings', 'pk_kings_test', '["https://portal.kings.test"]', '[]', 'KINGS', 0)`,
    ).bind(KEY, JSON.stringify([ORIGIN])),
  ])
}

export function payload(over: Partial<ReportPayload> = {}): ReportPayload {
  const now = Date.now()
  return {
    v: PAYLOAD_VERSION,
    project: 'space',
    createdAt: now,
    title: "can't save payment",
    expected: 'payment saved',
    severity: 'blocker',
    verdict: { kind: 'backend', headline: 'Backend error: 500 on POST /Payment/Create', confidence: 'high', evidenceEventId: 'e3', alsoSeen: [] },
    context: { userName: 'Ali', email: 'ali@example.com', role: 'owner', tenant: 'BVB 09', appVersion: 'abc123' },
    env: { url: 'https://portal.space.test/payments', userAgent: 'UA', language: 'en', timezone: 'Asia/Amman', viewport: { w: 1280, h: 800, dpr: 2 }, online: true },
    events: [
      { id: 'e1', t: now - 30_000, type: 'nav', url: '/payments' },
      { id: 'e2', t: now - 20_000, type: 'click', label: 'Save payment', context: 'Add Payment', tag: 'button' },
      {
        id: 'e3', t: now - 19_000, type: 'request', method: 'POST', url: 'https://api.space.test/Payment/Create',
        status: 500, durationMs: 120, outcome: 'http_error', requestId: 'req-111', requestBody: '{"amount":50}',
        responseBody: '{"success":false,"code":"InternalServerError"}', hadAuth: true,
      },
    ],
    curls: { e3: `curl -X POST 'https://api.space.test/Payment/Create' \\\n  -H "Authorization: Bearer $TOKEN"` },
    images: [{ part: 'image_0', kind: 'screenshot', name: 'screenshot.jpg' }],
    ...over,
  }
}

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9])
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

export function form(p: unknown, images: Record<string, { bytes: Uint8Array; type: string }> = { image_0: { bytes: JPEG, type: 'image/jpeg' } }): FormData {
  const f = new FormData()
  f.append('report', new Blob([typeof p === 'string' ? p : JSON.stringify(p)], { type: 'application/json' }), 'report.json')
  for (const [name, img] of Object.entries(images)) f.append(name, new File([img.bytes], `${name}.bin`, { type: img.type }))
  return f
}

let ipCounter = 0
export function ingestRequest(body: FormData, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/v1/reports`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'x-dalil-project': 'space', 'x-dalil-key': KEY, 'cf-connecting-ip': `10.0.0.${++ipCounter}`, ...headers },
    body,
  })
}

/** Calls the worker directly and waits for its waitUntil work (email). */
export async function call(req: Request, e: Env = testEnv()): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(req, e, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
