// 12-hour digest: one email per project listing every report not yet digested.
import { refOf, type SendOutcome } from './email'
import type { Env, ProjectRow, ReportRow } from './env'
import { kindLabel } from './steps'
import { esc, formatAmman, parseJsonArray, pathOf, reporterOf, truncate } from './util'

export const DIGEST_CRON = '0 6,18 * * *'
export const DIGEST_CAP = 200

export function digestSubject(project: Pick<ProjectRow, 'name'>, rows: ReportRow[]): string {
  const blockers = rows.filter((r) => r.severity === 'blocker').length
  return `[${project.name}] 12-hour bug digest — ${rows.length} reports (${blockers} blockers)`.replace(/[\r\n]+/g, ' ')
}

function tally(values: (string | null)[], label: (v: string | null) => string): string {
  const m = new Map<string, number>()
  for (const v of values) m.set(label(v), (m.get(label(v)) ?? 0) + 1)
  return [...m].map(([k, n]) => `${esc(k)}: ${n}`).join(' · ')
}

export function buildDigestHtml(env: Pick<Env, 'PUBLIC_BASE'>, project: ProjectRow, rows: ReportRow[], more: number): string {
  const base = env.PUBLIC_BASE
  const TD = 'style="padding:8px;border-top:1px solid #e4e4e7;vertical-align:top;font-size:13px"'
  const items = rows
    .map((r) => {
      const who = reporterOf(r.reporter)
      const whoText = [who.name, who.tenant].filter(Boolean).join(' · ') || 'unknown'
      const flags = [
        r.has_replay ? '🎥 recording' : '',
        r.auto_snaps ? `📸 ${r.auto_snaps} auto-snapshot${r.auto_snaps === 1 ? '' : 's'}` : '',
        r.email_status === 'sent' ? '<strong>(already emailed)</strong>' : '',
      ].filter(Boolean)
      return `<tr>
<td ${TD}><a href="${esc(base)}/r/${esc(r.id)}">${esc(refOf(project, r.seq))}</a><br><span style="color:#71717a">${esc(formatAmman(r.created_at))}</span></td>
<td ${TD}><strong>${esc(r.severity ?? '')}</strong><br>${esc(kindLabel(r.verdict_kind))}</td>
<td ${TD}>${esc(r.verdict_headline ?? '')}${r.user_saw ? `<br><em>User saw: "${esc(truncate(r.user_saw, 200))}"</em>` : ''}<br>${esc(truncate(r.title, 160))}</td>
<td ${TD}>${esc(whoText)}${r.page_url ? `<br><code>${esc(truncate(pathOf(r.page_url), 80))}</code>` : ''}<br>${flags.join(' · ')}</td>
</tr>`
    })
    .join('\n')
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px">
<h2 style="margin:0 0 8px">${esc(project.name)}: ${rows.length} new report${rows.length === 1 ? '' : 's'}</h2>
<p style="margin:2px 0;font-size:14px"><strong>By type</strong> — ${tally(rows.map((r) => r.verdict_kind), kindLabel2)}</p>
<p style="margin:2px 0 12px;font-size:14px"><strong>By severity</strong> — ${tally(rows.map((r) => r.severity), (v) => v ?? 'unknown')}</p>
<table style="border-collapse:collapse;width:100%">${items}</table>
${more > 0 ? `<p>+${more} more, see the reports page.</p>` : ''}
<p><a href="${esc(base)}/" style="display:inline-block;background:#2563eb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open reports page</a></p>
</div>`
}

const kindLabel2 = (v: string | null) => kindLabel(v)

async function sendDigest(env: Env, project: ProjectRow, rows: ReportRow[], more: number): Promise<SendOutcome> {
  const to = parseJsonArray(project.notify_emails)
  if (to.length === 0) return { status: 'skipped', detail: 'no notify_emails' }
  if (!env.RESEND_API_KEY) return { status: 'failed', detail: 'RESEND_API_KEY not set' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to, subject: digestSubject(project, rows), html: buildDigestHtml(env, project, rows, more) }),
    })
    if (!res.ok) return { status: 'failed', detail: `resend ${res.status}: ${(await res.text()).slice(0, 300)}` }
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', detail: String(err) }
  }
}

/** Sends one digest per project that has recipients and undigested reports. */
export async function runDigest(env: Env, now = Date.now()): Promise<{ sent: number; reports: number }> {
  const { results: projects } = await env.DB.prepare(`SELECT * FROM projects WHERE notify_emails <> '[]' AND notify_emails <> ''`).all<ProjectRow>()
  let sent = 0
  let reports = 0
  for (const project of projects) {
    if (parseJsonArray(project.notify_emails).length === 0) continue
    const { results } = await env.DB.prepare(
      `SELECT * FROM reports WHERE project_id = ? AND digested_at IS NULL ORDER BY created_at, seq LIMIT ?`,
    )
      .bind(project.id, DIGEST_CAP + 1)
      .all<ReportRow>()
    if (results.length === 0) continue
    const rows = results.slice(0, DIGEST_CAP)
    const more = results.length > DIGEST_CAP
      ? ((await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE project_id = ? AND digested_at IS NULL').bind(project.id).first<{ n: number }>())?.n ?? 0) - rows.length
      : 0
    const outcome = await sendDigest(env, project, rows, more)
    if (outcome.status !== 'sent') {
      console.error(`dalil: digest for ${project.id} not sent (${outcome.status}): ${outcome.detail}`)
      continue // digested_at stays NULL: the next run retries
    }
    await env.DB.batch(rows.map((r) => env.DB.prepare('UPDATE reports SET digested_at = ? WHERE id = ? AND digested_at IS NULL').bind(now, r.id)))
    sent++
    reports += rows.length
  }
  return { sent, reports }
}
