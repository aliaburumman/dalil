// Dalil collector — Cloudflare Worker (D1 + R2 + Resend). See README.md and docs/design.md §3.
import type { Env } from './env'
import { handleList } from './list'
import { handleIngest, handlePreflight } from './ingest'
import { handleAuto, handleImage, handlePage, handleReplay, handleStatus } from './page'
import { DIGEST_CRON, runDigest } from './digest'
import { runScheduled } from './scheduled'
import { json } from './util'

const LIST_PROJECT = /^\/p\/([^/]+)$/
const REPORT_PAGE = /^\/r\/([^/]+)$/
const REPORT_IMG = /^\/r\/([^/]+)\/img\/([^/]+)$/
const REPORT_AUTO = /^\/r\/([^/]+)\/auto\/([0-2])$/
const REPORT_REPLAY = /^\/r\/([^/]+)\/replay$/
const ASSET = /^\/assets\/rrweb-player\.[0-9A-Za-z.-]+\.(js|css)$/
const REPORT_STATUS = /^\/r\/([^/]+)\/status$/

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url)
    try {
      if (pathname === '/v1/reports') {
        if (req.method === 'OPTIONS') return await handlePreflight(req, env)
        if (req.method === 'POST') return await handleIngest(req, env, ctx)
        return json({ error: 'method not allowed' }, 405, { allow: 'POST, OPTIONS' })
      }
      let m: RegExpMatchArray | null
      if (req.method === 'GET' && pathname === '/') return await handleList(req, env, null)
      if (req.method === 'GET' && (m = pathname.match(LIST_PROJECT))) return await handleList(req, env, decodeURIComponent(m[1]!))
      if (req.method === 'GET' && (m = pathname.match(REPORT_PAGE))) return await handlePage(env, m[1]!, req)
      if (req.method === 'GET' && (m = pathname.match(REPORT_IMG))) return await handleImage(env, m[1]!, m[2]!)
      if (req.method === 'GET' && (m = pathname.match(REPORT_AUTO))) return await handleAuto(env, m[1]!, m[2]!)
      if (req.method === 'GET' && (m = pathname.match(REPORT_REPLAY))) return await handleReplay(env, m[1]!)
      if (req.method === 'GET' && ASSET.test(pathname)) return await env.ASSETS.fetch(req)
      if (req.method === 'POST' && (m = pathname.match(REPORT_STATUS))) return await handleStatus(req, env, m[1]!)
      return new Response('Not found', { status: 404 })
    } catch (err) {
      console.error(`dalil: unhandled ${req.method} ${pathname}: ${String(err)}`)
      return json({ error: 'internal error' }, 500)
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two crons (wrangler.jsonc): the 12-hourly digest, and the daily maintenance (default branch).
    ctx.waitUntil(controller.cron === DIGEST_CRON ? runDigest(env) : runScheduled(env))
  },
} satisfies ExportedHandler<Env>
