// Payload contract lives in shared/payload.ts (single source for widget + collector).
// Re-exported here so existing imports keep working; only client-only types are defined below.
import type { ReportContext } from '../../shared/payload'

export * from '../../shared/payload'

export interface DalilConfig {
  project: string
  publicKey: string
  endpoint: string // https://dalil.example.com/v1/reports
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
