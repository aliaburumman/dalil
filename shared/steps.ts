// Pure step helpers shared by the worker and the widget. No DOM or Workers types.
import type { DalilEvent, RequestEvent, VerdictKind } from './payload'
import { pathOf } from './text'

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

export function statusText(e: RequestEvent): string {
  if (e.outcome === 'timeout') return 'timeout'
  if (e.outcome === 'network' || e.status === 0) return 'network error'
  if (e.outcome === 'app_error') return `${e.status} success:false${e.appCode ? ` (${e.appCode})` : ''}`
  return String(e.status)
}

export function failedRequestTitle(e: RequestEvent): string {
  return `${e.method.toUpperCase()} ${pathOf(e.url)} → ${statusText(e)}`
}
