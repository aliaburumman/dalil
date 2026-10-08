// Email through the Resend REST API. Inline screenshot uses a CID attachment:
// attachments[].content_id + <img src="cid:...">. NOTE: `content_id` is the REST field
// name per Resend's "embed images" docs (the Node SDK calls it `contentId`); confirm
// with one live send before relying on the inline image.
import type { Env, ProjectRow, ReportRow } from './env'
import type { ReportPayload } from './payload'
import { failedRequests, failedRequestTitle, kindLabel, stepHtml } from './steps'
import { esc, formatTime, parseJsonArray, partKey, toBase64, truncate } from './util'

/** Total attachment budget; anything beyond is only linked from the report page. */
export const MAIL_ATTACH_BUDGET = 5_000_000

export interface StoredImage {
  part: string
  name: string
  kind: 'screenshot' | 'attachment' | 'auto'
  type: string
  bytes: Uint8Array
}

export function refOf(project: Pick<ProjectRow, 'key_prefix'>, seq: number): string {
  return `${project.key_prefix}-${seq}`
}

export function buildSubject(ref: string, p: ReportPayload): string {
  const s = `[${ref}] ${kindLabel(p.verdict?.kind)} · ${p.verdict?.headline ?? ''} · "${truncate(p.title, 60)}"`
  return s.replace(/[\r\n]+/g, ' ')
}

const PRE = 'style="background:#f4f4f5;padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all;font-size:12px"'

export interface InlineInfo {
  /** cid of the hero image: newest auto snapshot, else the on-open screenshot */
  hero?: 'autosnap' | 'screenshot'
  /** also show the on-open screenshot inline (only when the hero is an auto snapshot) */
  screenshot?: boolean
  heroCaption?: string
}

export function buildHtml(ref: string, row: ReportRow, p: ReportPayload, link: string, inline: InlineInfo = {}): string {
  const c = p.context ?? {}
  const who = [c.userName, c.email, c.role].filter(Boolean).join(' · ') || 'unknown user'
  const where = [c.tenant, p.env?.url].filter(Boolean).join(' · ')
  const steps = p.events.map(stepHtml).filter((s): s is string => s !== null)
  const failed = failedRequests(p)
  const errors = p.events.filter((e) => e.type === 'error')

  const parts: string[] = []
  parts.push(`<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px;color:#18181b">`)
  parts.push(`<h2 style="margin:0 0 4px">${esc(ref)} · ${esc(p.title)}</h2>`)
  if (p.expected) parts.push(`<p style="margin:0 0 8px"><em>Expected:</em> ${esc(p.expected)}</p>`)
  parts.push(
    `<p style="margin:0 0 12px"><strong>Likely: ${esc(kindLabel(p.verdict?.kind))}</strong> — ${esc(p.verdict?.headline)} <span style="color:#71717a">(${esc(p.verdict?.confidence)} confidence) · severity ${esc(p.severity)}</span></p>`,
  )
  parts.push(
    `<table style="font-size:13px;margin-bottom:12px"><tr><td style="color:#71717a;padding-right:8px">Who</td><td>${esc(who)}</td></tr><tr><td style="color:#71717a;padding-right:8px">Where</td><td>${esc(where)}</td></tr><tr><td style="color:#71717a;padding-right:8px">When</td><td>${esc(formatTime(row.created_at))}</td></tr>${c.appVersion ? `<tr><td style="color:#71717a;padding-right:8px">Version</td><td>${esc(c.appVersion)}</td></tr>` : ''}</table>`,
  )
  parts.push(`<p><a href="${esc(link)}">Open the report page →</a>${row.has_replay ? ` &nbsp;·&nbsp; <a href="${esc(link)}#replay">▶ Watch the last 2 minutes</a>` : ''}</p>`)
  const IMG = 'style="max-width:100%;border:1px solid #e4e4e7"'
  if (inline.hero) {
    const cid = inline.hero === 'autosnap' ? 'autosnap' : 'screenshot'
    parts.push(`<p style="margin-bottom:2px"><img src="cid:${cid}" alt="${esc(inline.heroCaption ?? 'Screenshot')}" ${IMG}></p>`)
    if (inline.heroCaption) parts.push(`<p style="margin-top:0;color:#71717a;font-size:13px">${esc(inline.heroCaption)}</p>`)
    if (inline.screenshot) parts.push(`<p style="margin-bottom:2px;color:#71717a;font-size:13px">Screenshot when the report was opened</p><p style="margin-top:0"><img src="cid:screenshot" alt="Screenshot" ${IMG}></p>`)
  } else if (p.screenshotError) parts.push(`<p style="color:#71717a">No screenshot: ${esc(p.screenshotError)}</p>`)

  if (steps.length) {
    parts.push(`<h3>Steps</h3><ol style="font-size:14px">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`)
  }
  if (failed.length) {
    parts.push(`<h3>Failed requests</h3>`)
    for (const e of failed) {
      parts.push(`<div style="margin-bottom:16px"><p style="margin:0 0 4px"><strong>${esc(failedRequestTitle(e))}</strong></p>`)
      if (e.requestId) parts.push(`<p style="margin:0 0 4px;font-size:13px">Request id: <code>${esc(e.requestId)}</code></p>`)
      const curl = p.curls?.[e.id]
      if (curl) parts.push(`<pre ${PRE}>${esc(curl)}</pre>`)
      if (e.responseBody) parts.push(`<p style="margin:4px 0;font-size:13px">Response</p><pre ${PRE}>${esc(e.responseBody)}</pre>`)
      parts.push(`</div>`)
    }
  }
  if (errors.length) {
    parts.push(`<h3>Errors</h3>`)
    for (const e of errors) {
      if (e.type !== 'error') continue
      parts.push(`<pre ${PRE}>${esc(e.message)}${e.stack ? `\n${esc(e.stack)}` : ''}</pre>`)
    }
  }
  parts.push(`</div>`)
  return parts.join('\n')
}

export interface SendOutcome {
  status: 'sent' | 'failed' | 'skipped'
  detail?: string
}

export async function sendReportEmail(
  env: Env,
  project: ProjectRow,
  row: ReportRow,
  payload: ReportPayload,
  images: StoredImage[],
): Promise<SendOutcome> {
  const to = parseJsonArray(project.notify_emails)
  if (to.length === 0) return { status: 'skipped', detail: 'no notify_emails' }
  if (!env.RESEND_API_KEY) return { status: 'failed', detail: 'RESEND_API_KEY not set' }

  const ref = refOf(project, row.seq)
  const link = `${env.PUBLIC_BASE}/r/${row.id}`
  const screenshot = images.find((i) => i.kind === 'screenshot')
  const ext = (t: string) => (t === 'image/png' ? 'png' : t === 'image/webp' ? 'webp' : 'jpg')

  // Hero = newest auto snapshot that was actually stored, else the on-open screenshot.
  const stored = new Map(images.filter((i) => i.kind === 'auto').map((i) => [i.part, i]))
  const newest = [...(payload.autoSnaps ?? [])].filter((a) => stored.has(a.part)).sort((a, b) => b.t - a.t)[0]
  const auto = newest ? stored.get(newest.part) : undefined

  // At most one auto snapshot (the hero) is attached, plus the on-open screenshot and
  // tester images, within a 5 MB total; the rest are only linked from the report page.
  let budget = MAIL_ATTACH_BUDGET
  const attachments: { filename: string; content: string; content_id?: string }[] = []
  const take = (img: StoredImage, extra: { filename: string; content_id?: string }) => {
    if (img.bytes.byteLength > budget) return false
    budget -= img.bytes.byteLength
    attachments.push({ ...extra, content: toBase64(img.bytes) })
    return true
  }
  const heroOk = auto ? take(auto, { filename: `auto-snapshot.${ext(auto.type)}`, content_id: 'autosnap' }) : false
  const shotOk = screenshot ? take(screenshot, { filename: `screenshot.${ext(screenshot.type)}`, content_id: 'screenshot' }) : false
  for (const img of images) {
    if (img.kind !== 'attachment') continue
    take(img, { filename: img.name || `${img.part}.${ext(img.type)}` })
  }
  const inline: InlineInfo = heroOk
    ? { hero: 'autosnap', screenshot: shotOk, heroCaption: `${formatTime(newest!.t).slice(11)} · ${newest!.label}` }
    : shotOk
      ? { hero: 'screenshot' }
      : {}

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to,
        subject: buildSubject(ref, payload),
        html: buildHtml(ref, row, payload, link, inline),
        ...(attachments.length ? { attachments } : {}),
      }),
    })
    if (!res.ok) return { status: 'failed', detail: `resend ${res.status}: ${(await res.text()).slice(0, 300)}` }
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', detail: String(err) }
  }
}

/** Load report.json + images from R2, send, record email_status. Used by ingest and cron. */
export async function deliverEmail(env: Env, row: ReportRow, project: ProjectRow, preloaded?: { payload: ReportPayload; images: StoredImage[] }): Promise<SendOutcome> {
  let outcome: SendOutcome
  try {
    const data = preloaded ?? (await loadStored(env, row))
    outcome = data ? await sendReportEmail(env, project, row, data.payload, data.images) : { status: 'failed', detail: 'report.json missing in R2' }
  } catch (err) {
    outcome = { status: 'failed', detail: String(err) }
  }
  if (outcome.status === 'failed') console.error(`dalil: email for ${row.id} failed: ${outcome.detail}`)
  await env.DB.prepare('UPDATE reports SET email_status = ? WHERE id = ?').bind(outcome.status, row.id).run()
  return outcome
}

export async function loadStored(env: Env, row: ReportRow): Promise<{ payload: ReportPayload; images: StoredImage[] } | null> {
  const obj = await env.BUCKET.get(`${row.r2_prefix}report.json`)
  if (!obj) return null
  const payload = (await obj.json()) as ReportPayload
  const images: StoredImage[] = []
  for (const meta of payload.images ?? []) {
    const img = await env.BUCKET.get(`${row.r2_prefix}${partKey(meta.part)}`)
    if (!img) continue
    images.push({
      part: meta.part,
      name: meta.name,
      kind: meta.kind,
      type: img.httpMetadata?.contentType ?? 'image/jpeg',
      bytes: new Uint8Array(await img.arrayBuffer()),
    })
  }
  return { payload, images }
}
