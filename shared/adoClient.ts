// Azure DevOps REST client shared by the worker and the widget. Environment-neutral: only the
// injected `fetch`, AbortSignal, TextEncoder and btoa. Errors carry a fixed code only, never a
// request body, header or token.
import type { Share } from './payload'
import { esc } from './text'

export type AdoErrorCode = 'auth' | 'forbidden' | 'notfound' | 'rejected' | 'unavailable' | 'timeout'

/** Short, fixed error codes (shown as fixed messages, never raw text). */
export class AdoError extends Error {
  constructor(readonly code: AdoErrorCode) {
    super(code)
  }
}

export const ADO_ERRORS: Record<string, string> = {
  auth: 'Azure DevOps rejected the access token (check ADO_PAT and its Work Items scope).',
  forbidden: 'Azure DevOps denied access (the token lacks permission on this project).',
  notfound: 'Azure DevOps organization or project was not found.',
  rejected: 'Azure DevOps rejected the work item (check ADO_WORK_ITEM_TYPE and ADO_BODY_FIELD).',
  unavailable: 'Azure DevOps could not be reached. Try again.',
  timeout: 'Azure DevOps took too long to answer. Try again.',
}

export interface AdoContext {
  fetch: typeof fetch
  org: string
  project: string
  /** full Authorization header value, e.g. from basicAuth(pat) */
  authHeader: string
  workItemType?: string
  bodyField?: string
}

/** An uploaded image to show in the Bug. `label` is the caption (autos) or empty (screenshots). */
export interface AdoMedia {
  url: string
  kind: 'screenshot' | 'auto'
  label: string
}

export interface AdoExtras {
  media?: AdoMedia[]
  /** images that could not be attached (upload failed or over the size cap) */
  failedMedia?: number
  /** replay link block; `url` is the evidence URL with ?play=failure */
  replay?: { url: string; durationMs: number } | null
  /** extra HTML appended at the end of the body (already escaped by the caller) */
  extraHtml?: string
}

export interface CreateOptions {
  hyperlink?: string
  extras?: AdoExtras
  tags?: string[]
  areaPath?: string
  /** files already uploaded, linked as AttachedFile relations in the same create call */
  attachments?: { url: string; comment?: string }[]
}

/** 'Basic ' + base64(utf8(':' + pat)). TextEncoder first, so non-Latin1 never throws. */
export function basicAuth(pat: string): string {
  const bytes = new TextEncoder().encode(`:${pat}`)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `Basic ${btoa(bin)}`
}

const base = (ctx: AdoContext): string => `https://dev.azure.com/${encodeURIComponent(ctx.org)}/${encodeURIComponent(ctx.project)}`

function failure(err: unknown): AdoError {
  return new AdoError(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unavailable')
}

function codeFor(status: number): AdoErrorCode {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notfound'
  return status >= 500 ? 'unavailable' : 'rejected'
}

/** Upload one image as an Azure DevOps attachment and return its url. Throws AdoError. */
export async function uploadAttachment(ctx: AdoContext, bytes: ArrayBuffer | Uint8Array, fileName: string): Promise<string> {
  const endpoint = `${base(ctx)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`
  let res: Response
  try {
    res = await ctx.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: ctx.authHeader },
      body: bytes as BodyInit,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw failure(err)
  }
  if (!res.ok) {
    console.error(`dalil: ado attachment upload failed: HTTP ${res.status}`)
    throw new AdoError(codeFor(res.status))
  }
  const body = (await res.json().catch(() => null)) as { url?: string } | null
  if (typeof body?.url === 'string' && /^https:\/\//.test(body.url)) return body.url
  throw new AdoError('rejected')
}

/** 42000 -> "0:42" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const IMG_STYLE = 'max-width:100%'

/** Repro Steps HTML: the share plus screenshots, replay link and a partial-failure note. img tags live here, not in share.ts. */
export function bodyHtml(share: Share, x: AdoExtras): string {
  const media = x.media ?? []
  const failed = x.failedMedia ?? 0
  let html = share.html
  if (media.length || failed) {
    html += '<p><b>Screenshots</b></p>'
    let shot = 0
    for (const m of media) {
      if (m.kind === 'screenshot') html += `<p><img src="${esc(m.url)}" alt="Screenshot ${++shot}" style="${IMG_STYLE}"></p>`
      else {
        const label = `Auto: ${m.label}`
        html += `<p><img src="${esc(m.url)}" alt="${esc(label)}" style="${IMG_STYLE}"><br>${esc(label)}</p>`
      }
    }
    if (failed) html += `<p>${failed} image${failed === 1 ? '' : 's'} couldn't be attached, see the report</p>`
  }
  if (x.replay) {
    const thumb = media[0] ? `<img src="${esc(media[0].url)}" alt="" width="320"><br>` : ''
    html += `<p><a href="${esc(x.replay.url)}">${thumb}▶ Watch replay (${formatDuration(x.replay.durationMs)}), jumps to the error</a></p>`
  }
  if (x.extraHtml) html += x.extraHtml
  return html
}

/** Create a work item; returns its web URL. Throws AdoError. */
export async function createWorkItem(ctx: AdoContext, share: Share, opts: CreateOptions = {}): Promise<string> {
  const type = ctx.workItemType || 'Bug'
  const bodyField = ctx.bodyField || 'Microsoft.VSTS.TCM.ReproSteps'
  const extras = opts.extras ?? {}
  const endpoint = `${base(ctx)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`
  const patch: Array<{ op: 'add'; path: string; value: unknown }> = [
    { op: 'add', path: '/fields/System.Title', value: share.title },
    { op: 'add', path: `/fields/${bodyField}`, value: bodyHtml(share, extras) },
  ]
  if (opts.tags?.length) patch.push({ op: 'add', path: '/fields/System.Tags', value: opts.tags.join('; ') })
  if (opts.areaPath) patch.push({ op: 'add', path: '/fields/System.AreaPath', value: opts.areaPath })
  if (opts.hyperlink) patch.push({ op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: opts.hyperlink, attributes: { comment: 'Dalil report' } } })
  for (const m of extras.media ?? []) {
    patch.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: m.url, attributes: { comment: 'Dalil screenshot' } } })
  }
  for (const a of opts.attachments ?? []) {
    patch.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: a.url, attributes: { comment: a.comment ?? 'Dalil attachment' } } })
  }
  let res: Response
  try {
    res = await ctx.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json-patch+json', authorization: ctx.authHeader },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    throw failure(err)
  }
  if (!res.ok) {
    console.error(`dalil: ado work item failed: HTTP ${res.status}`)
    throw new AdoError(codeFor(res.status))
  }
  const item = (await res.json().catch(() => null)) as { id?: number; _links?: { html?: { href?: string } } } | null
  const href = item?._links?.html?.href
  if (typeof href === 'string' && /^https:\/\//.test(href)) return href
  if (typeof item?.id === 'number') return `${base(ctx)}/_workitems/edit/${item.id}`
  throw new AdoError('rejected')
}

/** Names of the project's work item types. Throws AdoError (401 auth, 403 forbidden, 404 notfound). */
export async function listWorkItemTypes(ctx: AdoContext): Promise<string[]> {
  let res: Response
  try {
    res = await ctx.fetch(`${base(ctx)}/_apis/wit/workitemtypes?api-version=7.1`, {
      method: 'GET',
      headers: { authorization: ctx.authHeader },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    throw failure(err)
  }
  if (!res.ok) throw new AdoError(codeFor(res.status))
  const body = (await res.json().catch(() => null)) as { value?: Array<{ name?: unknown }> } | null
  return (body?.value ?? []).map((t) => t.name).filter((n): n is string => typeof n === 'string')
}
