// Human-readable rendering of payload events, shared by the email and the report page.
// Every user-supplied string goes through esc().
import type { DalilEvent, ReportPayload, RequestEvent, VerdictKind } from './payload'
import { esc, pathOf } from './util'

export const KIND_LABEL: Record<VerdictKind, string> = {
  network: 'Network',
  backend: 'Backend',
  permission: 'Permission',
  validation: 'Validation',
  frontend: 'Frontend',
  ux: 'UX',
}

export function kindLabel(kind: string | null | undefined): string {
  return (kind && KIND_LABEL[kind as VerdictKind]) || 'Unknown'
}

export function isFailedRequest(e: DalilEvent): e is RequestEvent {
  return (
    e.type === 'request' &&
    !e.refreshed &&
    (e.outcome === 'http_error' || e.outcome === 'app_error' || e.outcome === 'network' || e.outcome === 'timeout')
  )
}

function statusText(e: RequestEvent): string {
  if (e.outcome === 'timeout') return 'timeout'
  if (e.outcome === 'network' || e.status === 0) return 'network error'
  if (e.outcome === 'app_error') return `${e.status} success:false${e.appCode ? ` (${e.appCode})` : ''}`
  return String(e.status)
}

/** One HTML line for an event, or null when it is not worth a step (ok requests, info logs). */
export function stepHtml(e: DalilEvent): string | null {
  switch (e.type) {
    case 'nav':
      return `Opened <code>${esc(pathOf(e.url))}</code>`
    case 'click':
      return `Clicked <strong>${esc(e.label)}</strong>${e.context ? ` on <em>${esc(e.context)}</em>` : ''}`
    case 'input':
      return `Changed field <strong>${esc(e.field)}</strong>${e.context ? ` on <em>${esc(e.context)}</em>` : ''}`
    case 'submit':
      return `Submitted <strong>${esc(e.form)}</strong>${e.context ? ` on <em>${esc(e.context)}</em>` : ''}`
    case 'request':
      if (!isFailedRequest(e)) return null
      return `<code>${esc(e.method.toUpperCase())} ${esc(pathOf(e.url))}</code> → <strong>${esc(statusText(e))}</strong>`
    case 'error':
      return `JS error: ${esc(e.message)}`
    case 'log':
      return e.level === 'info' ? null : `Log (${esc(e.level)}): ${esc(e.message)}`
    default:
      return null
  }
}

/** Every event, including ok requests, for the full timeline on the report page. */
export function timelineHtml(e: DalilEvent): string {
  const step = stepHtml(e)
  if (step) return step
  if (e.type === 'request') {
    return `<code>${esc(e.method.toUpperCase())} ${esc(pathOf(e.url))}</code> → ${esc(e.outcome === 'aborted' ? 'aborted' : e.status)}${e.refreshed ? ' (refreshed)' : ''}`
  }
  if (e.type === 'log') return `Log: ${esc(e.message)}`
  return esc((e as { type?: string }).type ?? 'event')
}

export function failedRequests(p: ReportPayload): RequestEvent[] {
  return p.events.filter(isFailedRequest)
}

export function failedRequestTitle(e: RequestEvent): string {
  return `${e.method.toUpperCase()} ${pathOf(e.url)} → ${statusText(e)}`
}

export function relTime(eventT: number, createdAt: number): string {
  const s = Math.round((createdAt - eventT) / 1000)
  if (!Number.isFinite(s)) return ''
  if (s < 60) return `-${Math.max(s, 0)}s`
  return `-${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
