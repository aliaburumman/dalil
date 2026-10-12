// Azure DevOps: create a work item from a report's share. Enabled only when ADO_ORG, ADO_PROJECT and ADO_PAT are set.
import type { Env } from './env'
import type { Share } from './payload'

export const adoEnabled = (env: Env): boolean => !!(env.ADO_ORG && env.ADO_PROJECT && env.ADO_PAT)

/** Short, fixed error codes (shown on the triage page as fixed messages, never raw text). */
export class AdoError extends Error {
  constructor(readonly code: 'auth' | 'rejected' | 'unavailable' | 'timeout') {
    super(code)
  }
}

export async function createWorkItem(env: Env, share: Share, triageUrl: string): Promise<string> {
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
        { op: 'add', path: `/fields/${bodyField}`, value: share.html },
        { op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: triageUrl, attributes: { comment: 'Dalil report' } } },
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
