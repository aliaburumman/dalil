import type { DalilEvent, LogEvent, RequestEvent, Verdict, VerdictKind } from './types'

const WINDOW_MS = 90_000
const REFRESH_MS = 5_000
const FAILED: ReadonlySet<string> = new Set(['network', 'timeout', 'http_error', 'app_error'])

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://dalil.invalid').pathname
  } catch {
    return url.split(/[?#]/)[0] ?? url
  }
}

const reqLabel = (e: RequestEvent) => `${(e.method || 'GET').toUpperCase()} ${pathOf(e.url)}`
const endOf = (e: RequestEvent) => e.t + (e.durationMs || 0)
const clip = (s: string, n = 100) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** A 401 later retried successfully (same method + URL) within 5 s: silent token refresh. */
function isRefreshed401(e: RequestEvent, all: DalilEvent[]): boolean {
  if (e.status !== 401) return false
  if (e.refreshed) return true
  const end = endOf(e)
  return all.some(
    (o) =>
      o.type === 'request' &&
      o !== e &&
      o.outcome === 'ok' &&
      o.method === e.method &&
      o.url === e.url &&
      o.t >= e.t &&
      o.t - end <= REFRESH_MS,
  )
}

const isToast = (e: DalilEvent): boolean => e.type === 'log' && (e.source === 'toast' || e.message.startsWith('Toast: '))

function isFailure(e: DalilEvent, all: DalilEvent[]): boolean {
  if (isToast(e)) return false
  switch (e.type) {
    case 'request':
      if (!FAILED.has(e.outcome)) return false
      return !isRefreshed401(e, all)
    case 'error':
      return true
    case 'log':
      return e.level === 'error' || /zod|validation/i.test(e.message)
    default:
      return false
  }
}

function verdictFor(e: DalilEvent): Pick<Verdict, 'kind' | 'headline' | 'confidence'> {
  if (e.type === 'error') {
    return { kind: 'frontend', headline: `Frontend error: ${clip(e.message || 'uncaught exception')}`, confidence: 'high' }
  }
  if (e.type === 'log') {
    return { kind: 'frontend', headline: `Frontend error: ${clip(e.message)}`, confidence: 'medium' }
  }
  if (e.type !== 'request') return { kind: 'ux', headline: 'No technical failure seen', confidence: 'low' }

  const what = reqLabel(e)
  const v = (kind: VerdictKind, headline: string, confidence: Verdict['confidence']) => ({ kind, headline, confidence })
  if (e.outcome === 'timeout') return v('network', `Timed out: ${what}`, 'high')
  if (e.outcome === 'network' || e.status === 0) return v('network', `Network error: could not reach ${what}`, 'high')
  if (e.status >= 500) return v('backend', `Backend error: ${e.status} on ${what}`, 'high')
  if (e.appCode === 'InternalServerError') return v('backend', `Backend error: ${e.appCode} on ${what}`, 'high')
  if (e.status === 401 || e.status === 403) return v('permission', `Permission / session: ${e.status} on ${what}`, 'high')
  if (e.status === 400 || e.status === 422 || e.hasFieldErrors) {
    const code = e.status >= 400 ? String(e.status) : 'field errors'
    return v('validation', `Validation error: ${code} on ${what}`, 'medium')
  }
  if (e.outcome === 'app_error') {
    return v('validation', `Request rejected: ${e.appCode ?? 'success:false'} on ${what}`, 'medium')
  }
  // Other 4xx (404, 409, 429…): rejected by the backend, cause unclear.
  return v('validation', `Request rejected: ${e.status} on ${what}`, 'low')
}

/**
 * Pure verdict: looks at the 90 s before `openedAt` (or the whole buffer when
 * that window is empty), drops host aborts and refreshed 401s, and lets the
 * most recent failure decide.
 */
export function classify(events: DalilEvent[], openedAt: number): Verdict {
  const all = Array.isArray(events) ? events : []
  let win = all.filter((e) => e.t <= openedAt && e.t >= openedAt - WINDOW_MS)
  if (win.length === 0) win = all

  const failures = win
    .filter((e) => isFailure(e, all))
    .map((e, i) => ({ e, i, at: e.type === 'request' ? endOf(e) : e.t }))
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .map((x) => x.e)

  const toast = win.filter((e): e is LogEvent => isToast(e)).sort((a, b) => b.t - a.t)[0]
  const userSaw = toast ? toast.message.replace(/^Toast: /, '') : undefined
  const extra = userSaw !== undefined ? { userSaw } : {}

  const top = failures[0]
  if (!top) {
    if (toast) {
      return { kind: 'ux', headline: `User saw an error: "${clip(userSaw!)}"`, confidence: 'medium', evidenceEventId: toast.id, alsoSeen: [], ...extra }
    }
    return { kind: 'ux', headline: 'No technical failure seen', confidence: 'low', alsoSeen: [] }
  }
  return { ...verdictFor(top), evidenceEventId: top.id, alsoSeen: failures.slice(1).map((f) => f.id), ...extra }
}
