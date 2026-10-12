// Teams notification through a Workflows ("When a Teams webhook request is received") webhook.
// Classic O365 connector webhooks are retired. Best effort: never throws, never retries.
import type { Env } from './env'
import type { Share } from './payload'
import { SEV_LABEL } from './ui'

export interface NotifyMeta {
  /** triage page URL */
  url: string
  severity: string
  verdict: string | null
  page: string | null
  createdAt: number
}

export function teamsCard(share: Share, meta: NotifyMeta): unknown {
  const when = new Date(meta.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const sev = SEV_LABEL[meta.severity] ?? meta.severity
  const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'TextBlock', text: t, wrap: true, ...extra })
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            text(share.title, { weight: 'Bolder', size: 'Medium' }),
            text([sev, meta.verdict].filter(Boolean).join(' · ')),
            text([meta.page, when].filter(Boolean).join(' · '), { isSubtle: true, spacing: 'Small' }),
          ],
          actions: [{ type: 'Action.OpenUrl', title: 'Open report', url: meta.url }],
        },
      },
    ],
  }
}

export async function notifyTeams(env: Env, share: Share, meta: NotifyMeta): Promise<void> {
  const target = env.NOTIFY_WEBHOOK_URL
  if (!target) return
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(teamsCard(share, meta)),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) console.error(`dalil: teams notify failed: HTTP ${res.status}`)
  } catch (err) {
    console.error(`dalil: teams notify failed: ${String(err)}`)
  }
}
