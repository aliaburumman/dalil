// Azure DevOps: create a work item from a report's share. Enabled only when ADO_ORG, ADO_PROJECT and ADO_PAT are set.
import type { Env } from './env'
import type { Share } from './payload'
import { esc } from './util'

export const adoEnabled = (env: Env): boolean => !!(env.ADO_ORG && env.ADO_PROJECT && env.ADO_PAT)

/** Short, fixed error codes (shown on the triage page as fixed messages, never raw text). */
export class AdoError extends Error {
  constructor(readonly code: 'auth' | 'rejected' | 'unavailable' | 'timeout') {
    super(code)
  }
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
}

/** Upload one image as an Azure DevOps attachment and return its url. Throws AdoError. */
export async function uploadAttachment(env: Env, bytes: ArrayBuffer, fileName: string): Promise<string> {
  const org = encodeURIComponent(env.ADO_ORG!)
  const project = encodeURIComponent(env.ADO_PROJECT!)
  const endpoint = `https://dev.azure.com/${org}/${project}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', authorization: `Basic ${btoa(`:${env.ADO_PAT}`)}` },
      body: bytes,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new AdoError(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unavailable')
  }
  if (!res.ok) {
    console.error(`dalil: ado attachment upload failed: HTTP ${res.status}`)
    throw new AdoError(res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'unavailable' : 'rejected')
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
function bodyHtml(share: Share, x: AdoExtras): string {
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
    html += `<p><a href="${esc(x.replay.url)}">${thumb}\u25B6 Watch replay (${formatDuration(x.replay.durationMs)}), jumps to the error</a></p>`
  }
  return html
}

export async function createWorkItem(env: Env, share: Share, triageUrl: string, extras: AdoExtras = {}): Promise<string> {
  const org = encodeURIComponent(env.ADO_ORG!)
  const project = encodeURIComponent(env.ADO_PROJECT!)
  const type = env.ADO_WORK_ITEM_TYPE || 'Bug'
  const bodyField = env.ADO_BODY_FIELD || 'Microsoft.VSTS.TCM.ReproSteps'
  const endpoint = `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json-patch+json', authorization: `Basic ${btoa(`:${env.ADO_PAT}`)}` },
      body: JSON.stringify([
        { op: 'add', path: '/fields/System.Title', value: share.title },
        { op: 'add', path: `/fields/${bodyField}`, value: bodyHtml(share, extras) },
        { op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: triageUrl, attributes: { comment: 'Dalil report' } } },
        ...(extras.media ?? []).map((m) => ({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: m.url, attributes: { comment: 'Dalil screenshot' } } })),
      ]),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    throw new AdoError(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unavailable')
  }
  if (!res.ok) {
    console.error(`dalil: ado work item failed: HTTP ${res.status}`)
    throw new AdoError(res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'unavailable' : 'rejected')
  }
  const item = (await res.json().catch(() => null)) as { id?: number; _links?: { html?: { href?: string } } } | null
  const href = item?._links?.html?.href
  if (typeof href === 'string' && /^https:\/\//.test(href)) return href
  if (typeof item?.id === 'number') return `https://dev.azure.com/${org}/${project}/_workitems/edit/${item.id}`
  throw new AdoError('rejected')
}

export const ADO_ERRORS: Record<string, string> = {
  auth: 'Azure DevOps rejected the access token (check ADO_PAT and its Work Items scope).',
  rejected: 'Azure DevOps rejected the work item (check ADO_WORK_ITEM_TYPE and ADO_BODY_FIELD).',
  unavailable: 'Azure DevOps could not be reached. Try again.',
  timeout: 'Azure DevOps took too long to answer. Try again.',
}
