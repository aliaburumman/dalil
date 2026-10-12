// Paste-ready share of a report: `html` for rich editors (Teams, Azure DevOps), `text` for chat
// (WhatsApp). Deliberately minimal: title, verdict, up to 5 user steps, the first failed request,
// page + time, and a link to the full evidence. Never curl, headers, bodies, context, console or log text.
// `html` uses ONLY the tags b, p, ol, li, a, br; every user-derived string goes through esc().
import type { DalilEvent, Share } from './payload'
import { failedRequestTitle, isFailedRequest, kindLabel } from './steps'
import { esc, pathOf, truncate } from './util'

export interface ShareInput {
  ref: string
  title: string
  verdict?: { kind?: string | null; headline?: string | null } | null
  events?: DalilEvent[] | null
  pageUrl?: string | null
  createdAt: number
  /** triage page URL */
  url: string
}

const MAX_STEPS = 5
const ZWSP = '\u200B'

/**
 * WhatsApp has no escape character for *bold*, _italic_ and ~strike~. In user-derived text we put a
 * zero-width space after each marker so a stray pair cannot turn into formatting; it is invisible.
 */
function wa(s: string): string {
  return s.replace(/[*_~]/g, (c) => c + ZWSP)
}

/** Plain-language user steps (nav/click/input/submit), oldest first. */
function stepsOf(events: DalilEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    const on = (c?: string) => (c ? ` on ${truncate(c, 60)}` : '')
    if (e.type === 'nav') out.push(`Opened ${truncate(pathOf(e.url), 120)}`)
    else if (e.type === 'click') out.push(`Clicked ${truncate(e.label, 60)}${on(e.context)}`)
    else if (e.type === 'input') out.push(`Changed field ${truncate(e.field, 60)}${on(e.context)}`)
    else if (e.type === 'submit') out.push(`Submitted ${truncate(e.form, 60)}${on(e.context)}`)
  }
  return out
}

export function buildShare(input: ShareInput): Share {
  const title = truncate(input.title ?? '', 140)
  const heading = `${input.ref}: ${title}`
  const events = Array.isArray(input.events) ? input.events : []

  // Keep the steps closest to the failure; a leading "…" marks that earlier ones were left out.
  const all = stepsOf(events)
  const more = all.length > MAX_STEPS
  const steps = all.slice(-MAX_STEPS)

  const verdictLine = input.verdict?.headline ? `${kindLabel(input.verdict.kind)}: ${truncate(input.verdict.headline, 200)}` : null
  const failed = events.find(isFailedRequest)
  const reqLine = failed ? `${failedRequestTitle(failed)}${failed.requestId ? ` · X-Request-Id: ${truncate(failed.requestId, 100)}` : ''}` : null
  const when = Number.isFinite(input.createdAt) ? new Date(input.createdAt).toISOString().slice(0, 16) + 'Z' : ''
  const page = input.pageUrl ? truncate(pathOf(input.pageUrl), 200) : ''
  const pageLine = page || when ? [page && `Page: ${page}`, when].filter(Boolean).join(' · ') : null

  const h: string[] = [`<p><b>${esc(heading)}</b></p>`]
  if (verdictLine) h.push(`<p>${esc(verdictLine)}</p>`)
  if (steps.length) h.push(`<ol>${more ? '<li>…</li>' : ''}${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`)
  if (reqLine) h.push(`<p>${esc(reqLine)}</p>`)
  if (pageLine) h.push(`<p>${esc(pageLine)}</p>`)
  h.push(`<p><a href="${esc(input.url)}">Full evidence (screenshot, replay)</a></p>`)

  const t: string[] = [`*${wa(heading)}*`]
  if (verdictLine) t.push(wa(verdictLine))
  if (steps.length) {
    if (more) t.push('…')
    steps.forEach((s, i) => t.push(`${i + 1}. ${wa(s)}`))
  }
  if (reqLine) t.push(wa(reqLine))
  if (pageLine) t.push(wa(pageLine))
  t.push(`Full evidence: ${input.url}`)

  return { title: heading, html: h.join(''), text: t.join('\n') }
}
