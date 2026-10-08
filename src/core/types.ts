// The shared contract between the recorder (src/core), the widget (src/react)
// and the collector (worker/). The worker keeps a copy of the payload types in
// worker/src/payload.ts; bump PAYLOAD_VERSION when either side changes shape.

export const PAYLOAD_VERSION = 2

/** Every captured moment. `t` is epoch ms; `id` is unique within one page load. */
export type DalilEvent =
  | NavEvent
  | ClickEvent
  | InputEvent
  | SubmitEvent
  | RequestEvent
  | ErrorEvent
  | LogEvent

interface Base {
  id: string
  t: number
}

export interface NavEvent extends Base {
  type: 'nav'
  /** path + redacted search, never the hash */
  url: string
  from?: string
}

export interface ClickEvent extends Base {
  type: 'click'
  /** data-dalil-label › aria-label › trimmed innerText (60) › tag[role] */
  label: string
  /** nearest heading or dialog title, e.g. "Add Payment" */
  context?: string
  tag: string
}

export interface InputEvent extends Base {
  type: 'input'
  /** field name / label / placeholder. Never the value. */
  field: string
  context?: string
}

export interface SubmitEvent extends Base {
  type: 'submit'
  form: string
  context?: string
}

export type RequestOutcome =
  | 'ok'
  | 'http_error' // status >= 400
  | 'app_error' // 2xx with JSON { success: false }
  | 'network' // fetch rejected, status 0
  | 'timeout' // aborted with no caller signal having fired
  | 'aborted' // caller's own signal fired; never a failure

export interface RequestEvent extends Base {
  type: 'request'
  method: string
  /** absolute URL, query redacted */
  url: string
  status: number // 0 when no response
  durationMs: number
  outcome: RequestOutcome
  requestId?: string
  /** redacted, ≤10 KB; '[not captured]' / '[file: name, 12 KB]' descriptors allowed */
  requestBody?: string
  requestContentType?: string
  /** request carried an Authorization header (value never stored); curl emits "Bearer $TOKEN" */
  hadAuth?: boolean
  /** non-secret custom headers worth replaying, e.g. X-Client-Type */
  extraHeaders?: Record<string, string>
  /** only present when outcome is a failure; redacted, ≤10 KB */
  responseBody?: string
  /** app-level code from JSON body when present (e.g. "InternalServerError") */
  appCode?: string
  /** JSON body had a non-empty `errors` object (validation) */
  hasFieldErrors?: boolean
  /** 401 later retried successfully (silent token refresh). Classifier ignores it. */
  refreshed?: boolean
}

export interface ErrorEvent extends Base {
  type: 'error'
  source: 'window' | 'unhandledrejection' | 'console'
  message: string
  /** top 5 frames */
  stack?: string
}

export interface LogEvent extends Base {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
  /** redacted JSON string, ≤5 KB */
  data?: string
  /** 'toast' marks an on-screen error toast the user saw (evidence, not a failure) */
  source?: 'toast'
}

export type VerdictKind = 'network' | 'backend' | 'permission' | 'validation' | 'frontend' | 'ux'

export interface Verdict {
  kind: VerdictKind
  /** "Backend error: 500 on POST /Payment/Create" */
  headline: string
  confidence: 'high' | 'medium' | 'low'
  evidenceEventId?: string
  /** ids of other failures in the window, most recent first */
  alsoSeen: string[]
  /** text of the most recent error toast in the window, when one was shown */
  userSaw?: string
}

export type Severity = 'blocker' | 'annoying' | 'minor'

export interface ReportContext {
  userId?: string
  userName?: string
  email?: string
  role?: string
  tenant?: string
  tenantId?: string
  appVersion?: string
  [key: string]: string | undefined
}

export interface Environment {
  url: string
  userAgent: string
  language: string
  timezone: string
  viewport: { w: number; h: number; dpr: number }
  online: boolean
}

/** report.json — the multipart part named "report". Images go in parts image_0..image_5. */
export interface ReportPayload {
  v: typeof PAYLOAD_VERSION
  project: string
  createdAt: number
  title: string // "What went wrong?" (required)
  expected?: string // "What did you expect?"
  severity: Severity
  verdict: Verdict
  context: ReportContext
  env: Environment
  events: DalilEvent[]
  /** curl per failed request, keyed by event id */
  curls: Record<string, string>
  /** image part names in order; image_0 is the (annotated) screenshot when present */
  images: { part: string; kind: 'screenshot' | 'attachment' | 'auto'; name: string }[]
  screenshotError?: string
  /** v2: screens captured automatically at failure moments (parts auto_0..auto_2), oldest first */
  autoSnaps?: AutoSnapMeta[]
  /** v2: gzipped rrweb event JSON in part "replay" */
  replay?: ReplayMeta
  /** v2: why no replay was attached (unsupported, over cap, disabled, excluded by tester) */
  replayError?: string
}

export type AutoSnapReason = 'toast' | 'request' | 'error'

export interface AutoSnapMeta {
  part: string // auto_0..auto_2
  t: number
  reason: AutoSnapReason
  /** human label, e.g. "Error toast: Failed to save payment" or "POST /Payment/Create → 500" */
  label: string
  eventId?: string
}

export interface ReplayMeta {
  part: 'replay'
  durationMs: number
  events: number
  /** compressed bytes */
  bytes: number
  /** rrweb version that recorded it, for the player */
  rrweb: string
}

/** Collector response to POST /v1/reports */
export interface SubmitResult {
  id: string
  /** "SPACE-142" */
  ref: string
  url: string
}

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
  bufferMs?: number // default 300_000
  bufferMax?: number // default 300
}
