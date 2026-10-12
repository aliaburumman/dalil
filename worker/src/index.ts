// Dalil collector — Cloudflare Worker (D1 + R2 + Resend). See README.md and docs/design.md §3.
import type { Env } from './env'
import { accessDenied, verifyAccess } from './access'
import { DEFAULT_DIGEST_CRON, runDigest } from './digest'
import { ROUTES } from './routes'
import { runScheduled } from './scheduled'
import { json } from './util'

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url)
    try {
      // Deny by default: only public routes run without Access; every other path/method (even unknown) is 403.
      const hit = (pub: boolean) => {
        for (const r of ROUTES) {
          if (r.public !== pub || r.method !== req.method) continue
          const match = pathname.match(r.pattern)
          if (match) return { r, match }
        }
        return null
      }
      const pub = hit(true)
      if (pub) return await pub.r.handler({ req, env, ctx, match: pub.match, user: null })
      if (pathname === '/v1/reports') return json({ error: 'method not allowed' }, 405, { allow: 'POST, OPTIONS' })
      const user = await verifyAccess(req, env)
      if (!user) return accessDenied()
      const guarded = hit(false)
      if (guarded) return await guarded.r.handler({ req, env, ctx, match: guarded.match, user })
      return new Response('Not found', { status: 404 })
    } catch (err) {
      console.error(`dalil: unhandled ${req.method} ${pathname}: ${String(err)}`)
      return json({ error: 'internal error' }, 500)
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two crons (wrangler.jsonc): the 12-hourly digest, and the daily maintenance (default branch).
    // Cron expressions are UTC: in a DST zone the local digest time drifts 1 h twice a year.
    // env.DIGEST_CRON must match the digest entry in wrangler "triggers.crons".
    ctx.waitUntil(controller.cron === (env.DIGEST_CRON ?? DEFAULT_DIGEST_CRON) ? runDigest(env) : runScheduled(env))
  },
} satisfies ExportedHandler<Env>
