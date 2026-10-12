// Azure DevOps: create a work item from a report's share. Enabled only when ADO_ORG, ADO_PROJECT and ADO_PAT are set.
// Thin wrapper over shared/adoClient: builds the explicit context from env.
import type { Env } from './env'
import type { Share } from './payload'
import * as client from '../../shared/adoClient'
import { AdoError, type AdoExtras } from '../../shared/adoClient'

export { AdoError, formatDuration, ADO_ERRORS } from '../../shared/adoClient'
export type { AdoExtras, AdoMedia } from '../../shared/adoClient'

export const adoEnabled = (env: Env): boolean => !!(env.ADO_ORG && env.ADO_PROJECT && env.ADO_PAT)

const ctxOf = (env: Env): client.AdoContext => ({
  fetch: (input, init) => fetch(input, init),
  org: env.ADO_ORG!,
  project: env.ADO_PROJECT!,
  authHeader: client.basicAuth(env.ADO_PAT!),
  workItemType: env.ADO_WORK_ITEM_TYPE || undefined,
  bodyField: env.ADO_BODY_FIELD || undefined,
})

// The worker keeps its original codes: 403 -> auth, 404 -> rejected.
async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof AdoError && err.code === 'forbidden') throw new AdoError('auth')
    if (err instanceof AdoError && err.code === 'notfound') throw new AdoError('rejected')
    throw err
  }
}

/** Upload one image as an Azure DevOps attachment and return its url. Throws AdoError. */
export function uploadAttachment(env: Env, bytes: ArrayBuffer, fileName: string): Promise<string> {
  return wrap(() => client.uploadAttachment(ctxOf(env), bytes, fileName))
}

export function createWorkItem(env: Env, share: Share, triageUrl: string, extras: AdoExtras = {}): Promise<string> {
  return wrap(() => client.createWorkItem(ctxOf(env), share, { hyperlink: triageUrl, extras }))
}
