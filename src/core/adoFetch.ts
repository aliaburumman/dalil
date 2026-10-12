// The fetch used for every Azure DevOps and player-asset request: the recorder's original
// (unpatched) fetch, marked internal, so Dalil's own calls never show up as request events.
import { getOriginalFetch, internalInit } from './recorder'

export function adoFetch(): typeof fetch {
  const f = getOriginalFetch()
  return ((input: RequestInfo | URL, init?: RequestInit) => f(input, internalInit(init))) as typeof fetch
}

/** Where the widget script was loaded from (IIFE build only). Captured synchronously at load, since document.currentScript is null afterwards. */
let scriptUrl: string | undefined

export function setScriptUrl(url: string | null | undefined): void {
  if (url && !scriptUrl) scriptUrl = url
}

export function getScriptUrl(): string | undefined {
  return scriptUrl
}
