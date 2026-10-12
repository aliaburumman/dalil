// Payload contract lives in shared/payload.ts (single source for widget + collector).
// Re-exported here so existing imports keep working; only client-only types are defined below.
import type { ReportContext } from '../../shared/payload'

export * from '../../shared/payload'

/** Where reports go. `collector` (default) posts to `endpoint`; `azure-devops` files a work item straight from the browser. */
export type DalilDestination =
  | { type: 'collector' }
  | AdoDestination

export interface AdoDestination {
  type: 'azure-devops'
  org: string
  project: string
  /** default 'Bug' */
  workItemType?: string
  /** default 'Microsoft.VSTS.TCM.ReproSteps' (Basic process: 'System.Description') */
  bodyField?: string
  areaPath?: string
  /** extra tags; 'dalil' is always added */
  tags?: string[]
}

export interface DalilConfig {
  project: string
  /** collector mode only; not needed with destination.type === 'azure-devops' */
  publicKey?: string
  /** collector mode only: https://dalil.example.com/v1/reports */
  endpoint?: string
  /** default { type: 'collector' } */
  destination?: DalilDestination
  /** Folder URL that serves rrweb-player.2.1.7.js/.css for the portable replay (default: dist/assets next to the widget). */
  playerUrl?: string
  /** origins that receive X-Request-Id; others are never touched */
  apiOrigins?: string[]
  getContext?: () => ReportContext
  /** extra key patterns to redact (whole key or camelCase segment) */
  redactKeys?: string[]
  /** override failure detection */
  isFailure?: (status: number, json: unknown) => boolean
  /** v0.3: CSS selectors for error toasts; defaults cover sonner, ngx-toastr, react-toastify, notistack */
  toastSelectors?: string[]
  /** Guaranteed minimum seconds of screen recording kept (default 30, clamped to 15-120); the recording holds up to twice this. */
  replaySeconds?: number
  bufferMs?: number // default 300_000
  bufferMax?: number // default 300
}
