import type { RequestEvent } from './types'
import { TRUNCATED } from './redact'

/** Single-quote for POSIX shells: ' → '\'' */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

const isDescriptor = (b: string) => /^\[(not captured|file:|blob:|binary:|multipart\])/.test(b)

/**
 * Multi-line curl for a recorded request. The Authorization header is emitted
 * as "Bearer $TOKEN" (double quotes so the shell expands it); every other value
 * is single-quoted. Multipart and uncaptured bodies become a leading comment.
 */
export function toCurl(e: RequestEvent): string {
  const method = (e.method || 'GET').toUpperCase()
  const comments: string[] = []
  const lines: string[] = []

  if (method === 'GET') lines.push(`curl ${shq(e.url)}`)
  else if (method === 'HEAD') lines.push(`curl --head ${shq(e.url)}`)
  else lines.push(`curl -X ${method} ${shq(e.url)}`)

  if (e.hadAuth) lines.push(`-H "Authorization: Bearer $TOKEN"`)

  const ct = e.requestContentType
  const multipart =
    (ct && /multipart\//i.test(ct)) || (e.requestBody !== undefined && e.requestBody.startsWith('[multipart]'))
  if (ct && !multipart) lines.push(`-H ${shq(`Content-Type: ${ct}`)}`)
  if (e.requestId) lines.push(`-H ${shq(`X-Request-Id: ${e.requestId}`)}`)
  for (const [k, v] of Object.entries(e.extraHeaders ?? {})) {
    if (/^x-request-id$/i.test(k)) continue
    lines.push(`-H ${shq(`${k}: ${v}`)}`)
  }

  const body = e.requestBody
  if (body !== undefined && body !== '' && method !== 'GET' && method !== 'HEAD') {
    if (multipart) {
      comments.push(`# multipart body not reproduced: ${body.replace(/^\[multipart\]\s*/, '').replace(/\n/g, ' ')}`)
    } else if (isDescriptor(body)) {
      comments.push(`# body not reproduced: ${body.replace(/\n/g, ' ')}`)
    } else {
      if (body.endsWith(TRUNCATED)) comments.push('# body was truncated at 10 KB; the replay will differ')
      if (body.includes('[REDACTED]')) comments.push('# some values were redacted; fill them in before replaying')
      lines.push(`--data-raw ${shq(body)}`)
    }
  }

  const cmd = lines.join(' \\\n  ')
  return comments.length ? `${comments.join('\n')}\n${cmd}` : cmd
}
