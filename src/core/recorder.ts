import { classify } from './classify'
import { toCurl } from './curl'
import {
  describeBody,
  headerEntries,
  isSecretHeader,
  MAX_BODY,
  redactJsonString,
  redactText,
  redactUrl,
  truncate,
} from './redact'
import { flushPending } from './submit'
import type {
  DalilConfig,
  DalilEvent,
  ErrorEvent as DalilErrorEvent,
  RequestEvent,
  RequestOutcome,
  Verdict,
} from './types'

type NewEvent = DalilEvent extends infer E ? (E extends DalilEvent ? Omit<E, 'id' | 't'> & { t?: number } : never) : never

const STORAGE_KEY = 'dalil:events'
const STORAGE_MAX = 300_000
const MAX_CLONE = 64 * 1024
const INPUT_DEDUPE_MS = 2_000
const REFRESH_MS = 5_000
const FAILED: ReadonlySet<RequestOutcome> = new Set(['network', 'timeout', 'http_error', 'app_error'])

// ---------------- state ----------------

let config: DalilConfig | null = null
let events: DalilEvent[] = []
let seq = 0
const pageToken = Math.random().toString(36).slice(2, 7)
let restoreFns: (() => void)[] = []
let mirrorTimer: ReturnType<typeof setTimeout> | null = null
let lastMirrorWrite = 0
let lastNavUrl: string | undefined
let inConsoleError = false
const lastInput = new Map<string, number>()
const openListeners = new Set<() => void>()
let nativeFetch: typeof fetch | null = null

const safe = (fn: () => void) => {
  try {
    fn()
  } catch {
    /* never break the host */
  }
}

const newId = () => `${(++seq).toString(36)}${pageToken}`

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

const extraKeys = () => config?.redactKeys

// ---------------- buffer ----------------

function prune(now = Date.now()) {
  const ms = config?.bufferMs ?? 300_000
  const max = config?.bufferMax ?? 300
  const cutoff = now - ms
  if (events.length && events[0]!.t < cutoff) events = events.filter((e) => e.t >= cutoff)
  if (events.length > max) events = events.slice(events.length - max)
}

function push(partial: NewEvent): DalilEvent {
  const e = { ...partial, id: newId(), t: partial.t ?? Date.now() } as DalilEvent
  // keep sorted by t (requests are pushed on completion with their start time)
  let i = events.length
  while (i > 0 && events[i - 1]!.t > e.t) i--
  events.splice(i, 0, e)
  prune()
  scheduleMirror()
  return e
}

// ---------------- sessionStorage mirror (summaries only) ----------------

function summary(e: DalilEvent): DalilEvent {
  if (e.type === 'request') {
    const { requestBody: _rq, responseBody: _rs, ...rest } = e
    return rest
  }
  if (e.type === 'log') {
    const { data: _d, ...rest } = e
    return rest
  }
  return e
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

function writeMirror() {
  mirrorTimer = null
  lastMirrorWrite = Date.now()
  safe(() => {
    const s = storage()
    if (!s) return
    let list = events.map(summary)
    let json = JSON.stringify(list)
    while (json.length > STORAGE_MAX && list.length > 0) {
      list = list.slice(Math.max(1, Math.ceil(list.length * 0.1)))
      json = JSON.stringify(list)
    }
    s.setItem(STORAGE_KEY, json)
  })
}

function scheduleMirror() {
  if (!config || mirrorTimer) return
  const wait = Math.max(0, 1000 - (Date.now() - lastMirrorWrite))
  mirrorTimer = setTimeout(writeMirror, wait)
}

function restoreMirror() {
  safe(() => {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return
    const list = JSON.parse(raw) as DalilEvent[]
    if (!Array.isArray(list)) return
    const known = new Set(events.map((e) => e.id))
    const restored = list.filter(
      (e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.t === 'number' && !known.has(e.id),
    )
    events = restored.concat(events).sort((a, b) => a.t - b.t)
    prune()
  })
}

/** Test hook: write the mirror now instead of waiting for the throttle. */
export function __flushMirrorForTests() {
  if (mirrorTimer) clearTimeout(mirrorTimer)
  writeMirror()
}

// ---------------- DOM helpers ----------------

const clean = (s: string | null | undefined, n = 60) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t
}

function textOf(el: Element): string {
  const h = el as HTMLElement
  const raw = typeof h.innerText === 'string' ? h.innerText : el.textContent
  return clean(raw)
}

function isIgnored(el: Element | null): boolean {
  try {
    return !!el?.closest('[data-dalil-ignore]')
  } catch {
    return false
  }
}

function asElement(t: EventTarget | null): Element | null {
  if (!t) return null
  if ((t as Node).nodeType === 1) return t as Element
  if ((t as Node).nodeType === 3) return (t as Node).parentElement
  return null
}

function labelledBy(el: Element): string {
  const ids = el.getAttribute('aria-labelledby')
  if (!ids) return ''
  return clean(
    ids
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' '),
  )
}

/** Nearest heading (h1–h3) or dialog title among the ancestors. */
function contextOf(el: Element): string | undefined {
  let a: Element | null = el.parentElement
  while (a && a !== el.ownerDocument.documentElement) {
    if (a.getAttribute('role') === 'dialog' || a.getAttribute('role') === 'alertdialog' || a.tagName === 'DIALOG') {
      const t =
        clean(a.getAttribute('aria-label')) ||
        labelledBy(a) ||
        clean(a.getAttribute('title')) ||
        textOf(a.querySelector('h1,h2,h3,h4') ?? a.ownerDocument.createElement('i'))
      if (t) return redactText(t)
    }
    const h = a.querySelector('h1,h2,h3')
    if (h) {
      const t = textOf(h)
      if (t) return redactText(t)
    }
    a = a.parentElement
  }
  return undefined
}

const CLICKABLE =
  'button,a,summary,label,select,[data-dalil-label],[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],input[type=checkbox],input[type=radio],input[type=submit],input[type=button],input[type=reset]'

function fieldName(el: Element): string {
  const i = el as HTMLInputElement
  const byLabel = () => {
    try {
      const l = i.labels?.[0] ?? el.closest('label')
      return l ? textOf(l) : ''
    } catch {
      return ''
    }
  }
  return redactText(
    clean(el.getAttribute('name')) ||
      clean(el.getAttribute('aria-label')) ||
      labelledBy(el) ||
      byLabel() ||
      clean(el.getAttribute('placeholder')) ||
      clean(el.id) ||
      el.tagName.toLowerCase(),
  )
}

function clickLabel(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role')
  const isField = /^(input|select|textarea)$/.test(tag)
  const own = clean(el.getAttribute('data-dalil-label')) || clean(el.getAttribute('aria-label')) || labelledBy(el)
  if (own) return redactText(own)
  if (!isField) {
    const t = textOf(el)
    if (t) return redactText(t)
  }
  if (isField) {
    const type = (el as HTMLInputElement).type
    if (type === 'submit' || type === 'button' || type === 'reset') {
      const v = clean((el as HTMLInputElement).value)
      if (v) return redactText(v)
    }
    return fieldName(el)
  }
  const title = clean(el.getAttribute('title')) || clean(el.getAttribute('alt'))
  if (title) return redactText(title)
  return role ? `${tag}[role=${role}]` : tag
}

function onClick(ev: Event) {
  safe(() => {
    const target = asElement(ev.target)
    if (!target || isIgnored(target)) return
    const el = target.closest(CLICKABLE) ?? target
    push({ type: 'click', label: clickLabel(el), context: contextOf(el), tag: el.tagName.toLowerCase() })
  })
}

function onInput(ev: Event) {
  safe(() => {
    const el = asElement(ev.target)
    if (!el || isIgnored(el)) return
    const tag = el.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !(el as HTMLElement).isContentEditable) return
    const field = fieldName(el)
    const context = contextOf(el)
    const key = `${field}\u0000${context ?? ''}`
    const now = Date.now()
    const prev = lastInput.get(key)
    lastInput.set(key, now)
    if (prev !== undefined && now - prev < INPUT_DEDUPE_MS) return
    if (lastInput.size > 200) lastInput.clear()
    push({ type: 'input', field, context })
  })
}

function onSubmit(ev: Event) {
  safe(() => {
    const el = asElement(ev.target)
    if (!el || isIgnored(el)) return
    const form =
      clean(el.getAttribute('data-dalil-label')) ||
      clean(el.getAttribute('aria-label')) ||
      labelledBy(el) ||
      clean(el.getAttribute('name')) ||
      clean(el.id) ||
      textOf(el.querySelector('h1,h2,h3,h4,legend') ?? el.ownerDocument.createElement('i')) ||
      'form'
    push({ type: 'submit', form: redactText(form), context: contextOf(el) })
  })
}

// ---------------- errors ----------------

function stackOf(err: unknown): string | undefined {
  const s = (err as Error | undefined)?.stack
  if (typeof s !== 'string') return undefined
  const msg = (err as Error).message
  const frames = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== msg && !l.endsWith(`: ${msg}`) && (/^at\s/.test(l) || l.includes('@') || /:\d+/.test(l)))
    .slice(0, 5)
  return frames.length ? redactText(frames.join('\n')) : undefined
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s
  } catch {
    return String(v)
  }
}

function pushError(source: DalilErrorEvent['source'], message: string, err?: unknown) {
  push({ type: 'error', source, message: truncate(redactText(message), 2000), stack: stackOf(err) })
}

function onWindowError(ev: Event) {
  safe(() => {
    const e = ev as globalThis.ErrorEvent
    if (!e.message && !e.error) return // resource load errors
    pushError('window', e.message || stringify(e.error), e.error)
  })
}

function onRejection(ev: Event) {
  safe(() => {
    const reason = (ev as PromiseRejectionEvent).reason
    if ((reason as Error | undefined)?.name === 'AbortError') return
    pushError('unhandledrejection', reason instanceof Error ? `${reason.name}: ${reason.message}` : stringify(reason), reason)
  })
}

// ---------------- requests ----------------

interface ReqCtx {
  method: string
  url: string // redacted
  rawUrl: string
  start: number
  requestId?: string
  hadAuth: boolean
  extraHeaders?: Record<string, string>
  requestBody?: string
  requestContentType?: string
  callerSignal?: AbortSignal | null
}

function isApiOrigin(absUrl: string): boolean {
  const list = config?.apiOrigins
  if (!list?.length) return false
  try {
    const o = new URL(absUrl).origin
    return list.some((a) => {
      try {
        return new URL(a).origin === o
      } catch {
        return a === o
      }
    })
  } catch {
    return false
  }
}

function isOwnEndpoint(absUrl: string): boolean {
  const ep = config?.endpoint
  if (!ep) return false
  try {
    const a = new URL(absUrl)
    const b = new URL(ep, location.href)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

function absolute(u: string): string {
  try {
    return new URL(u, location.href).href
  } catch {
    return u
  }
}

function headerInfo(entries: [string, string][]) {
  let hadAuth = false
  let contentType: string | undefined
  let requestId: string | undefined
  const extra: Record<string, string> = {}
  for (const [k, v] of entries) {
    const lk = k.toLowerCase()
    if (lk === 'authorization') hadAuth = true
    else if (lk === 'content-type') contentType = v
    else if (lk === 'x-request-id') requestId = v
    else if (lk.startsWith('x-') && !isSecretHeader(lk)) extra[k] = redactText(v)
  }
  return { hadAuth, contentType, requestId, extra: Object.keys(extra).length ? extra : undefined }
}

function withHeader(h: HeadersInit | undefined, name: string, value: string): HeadersInit {
  if (!h) return { [name]: value }
  if (typeof (h as Headers).set === 'function' && typeof (h as Headers).forEach === 'function') {
    const copy = new Headers(h as Headers)
    copy.set(name, value)
    return copy
  }
  if (Array.isArray(h)) return [...h, [name, value]] as [string, string][]
  return { ...(h as Record<string, string>), [name]: value }
}

function isRequest(v: unknown): v is Request {
  return (
    (typeof Request !== 'undefined' && v instanceof Request) ||
    Object.prototype.toString.call(v) === '[object Request]'
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function judge(status: number, json: unknown): { outcome: RequestOutcome; appCode?: string; hasFieldErrors?: boolean } {
  const j = json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined
  const code = j && (typeof j.code === 'string' || typeof j.code === 'number') ? String(j.code) : undefined
  const errs = j?.errors
  const hasFieldErrors =
    errs && typeof errs === 'object' && Object.keys(errs as object).length > 0 ? true : undefined
  let failed: boolean
  const custom = config?.isFailure
  if (custom) {
    try {
      failed = !!custom(status, json)
    } catch {
      failed = status >= 400 || j?.success === false
    }
  } else failed = status >= 400 || j?.success === false
  const outcome: RequestOutcome = !failed ? 'ok' : status >= 400 ? 'http_error' : 'app_error'
  return { outcome, appCode: code, hasFieldErrors }
}

function markRefreshed(ok: RequestEvent) {
  for (const e of events) {
    if (
      e.type === 'request' &&
      e.status === 401 &&
      !e.refreshed &&
      e !== ok &&
      e.method === ok.method &&
      e.url === ok.url &&
      e.t <= ok.t &&
      ok.t - (e.t + e.durationMs) <= REFRESH_MS
    ) {
      e.refreshed = true
      scheduleMirror()
    }
  }
}

function record(
  ctx: ReqCtx,
  status: number,
  outcome: RequestOutcome,
  extra: Partial<Pick<RequestEvent, 'responseBody' | 'appCode' | 'hasFieldErrors'>> = {},
) {
  const failed = FAILED.has(outcome)
  const e = push({
    type: 'request',
    t: ctx.start,
    method: ctx.method,
    url: ctx.url,
    status,
    durationMs: Math.max(0, Date.now() - ctx.start),
    outcome,
    requestId: ctx.requestId,
    requestBody: ctx.requestBody,
    requestContentType: ctx.requestContentType,
    hadAuth: ctx.hadAuth || undefined,
    extraHeaders: ctx.extraHeaders,
    responseBody: failed ? extra.responseBody : undefined,
    appCode: extra.appCode,
    hasFieldErrors: extra.hasFieldErrors,
  }) as RequestEvent
  if (outcome === 'ok') markRefreshed(e)
}

function rejectionOutcome(err: unknown, signal?: AbortSignal | null): RequestOutcome {
  const name = (err as Error | undefined)?.name
  if (signal?.aborted) {
    const reasonName = (signal.reason as Error | undefined)?.name
    return reasonName === 'TimeoutError' ? 'timeout' : 'aborted'
  }
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  return 'network'
}

async function captureResponse(res: Response, clone: Response | null, ctx: ReqCtx) {
  let text: string | undefined
  if (clone) {
    try {
      text = await clone.text()
    } catch {
      text = undefined
    }
  }
  const isJson = /[/+]json\b/i.test(res.headers.get('content-type') ?? '')
  const json = text !== undefined && isJson ? parseJson(text) : undefined
  const status = res.type === 'opaque' || res.type === 'opaqueredirect' ? 0 : res.status
  if (res.type === 'opaque' || res.type === 'opaqueredirect') {
    record(ctx, 0, 'ok')
    return
  }
  const { outcome, appCode, hasFieldErrors } = judge(status, json)
  const responseBody =
    text !== undefined && !isJson
      ? truncate(redactText(text), MAX_BODY)
      : text !== undefined
        ? redactJsonString(text, extraKeys(), MAX_BODY)
        : FAILED.has(outcome) ? '[not captured]' : undefined
  record(ctx, status, outcome, { responseBody, appCode, hasFieldErrors })
}

function shouldClone(res: Response): boolean {
  try {
    if (res.bodyUsed || !res.body && res.status === 204) return false
    const ct = res.headers.get('content-type') ?? ''
    const isJson = /[/+]json\b/i.test(ct)
    // Failure pages (e.g. a proxy's HTML 502) are worth keeping; never clone 2xx non-JSON.
    if (!isJson && !(res.status >= 400 && /^text\//i.test(ct))) return false
    const len = res.headers.get('content-length')
    if (len !== null && len !== '' && !(Number(len) <= MAX_CLONE)) return false
    return true
  } catch {
    return false
  }
}

function patchFetch() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  const orig = window.fetch
  nativeFetch = orig
  const patched = function dalilFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let ctx: ReqCtx | null = null
    let callInput = input
    let callInit = init
    let bodyClone: Request | null = null
    try {
      const req = isRequest(input) ? input : null
      const rawUrl = absolute(req ? req.url : String(input))
      if (!isOwnEndpoint(rawUrl)) {
        const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
        const headerSource = init?.headers !== undefined ? init.headers : req?.headers
        const info = headerInfo(headerEntries(headerSource as HeadersInit))
        let requestId = info.requestId
        if (!requestId && isApiOrigin(rawUrl)) {
          requestId = uuid()
          if (init?.headers !== undefined) {
            callInit = { ...init, headers: withHeader(init.headers, 'X-Request-Id', requestId) }
          } else if (req) {
            callInit = { ...(init ?? {}), headers: withHeader(req.headers, 'X-Request-Id', requestId) }
          } else {
            callInit = { ...(init ?? {}), headers: { 'X-Request-Id': requestId } }
          }
        }
        ctx = {
          method,
          rawUrl,
          url: redactUrl(rawUrl, extraKeys()),
          start: Date.now(),
          requestId,
          hadAuth: info.hadAuth,
          extraHeaders: info.extra,
          requestContentType: info.contentType,
          callerSignal: init?.signal ?? req?.signal ?? null,
        }
        if (init && init.body !== undefined && init.body !== null) {
          const d = describeBody(init.body, extraKeys())
          ctx.requestBody = d.body
          ctx.requestContentType ??= d.contentType ?? (typeof init.body === 'string' ? 'text/plain;charset=UTF-8' : undefined)
        } else if (req && req.body && method !== 'GET' && method !== 'HEAD' && !req.bodyUsed) {
          const ct = info.contentType ?? ''
          if (/multipart\//i.test(ct)) ctx.requestBody = '[multipart] (fields not listed)'
          else if (/json|text|x-www-form-urlencoded/i.test(ct)) bodyClone = req.clone()
          else ctx.requestBody = '[not captured]'
        }
      }
    } catch {
      ctx = null
      callInput = input
      callInit = init
    }

    const p = orig.call(this ?? window, callInput, callInit) as Promise<Response>
    if (!ctx) return p
    const c = ctx
    try {
      p.then(
        (res) => {
          try {
            const clone = shouldClone(res) ? res.clone() : null
            const run = async () => {
              if (bodyClone) {
                try {
                  c.requestBody = redactJsonString(await bodyClone.text(), extraKeys())
                } catch {
                  c.requestBody = '[not captured]'
                }
              }
              await captureResponse(res, clone, c)
            }
            run().catch(() => {})
          } catch {
            /* ignore */
          }
        },
        (err) => {
          safe(() => {
            const outcome = rejectionOutcome(err, c.callerSignal)
            if (bodyClone) {
              void bodyClone
                .text()
                .then((t) => (c.requestBody = redactJsonString(t, extraKeys())))
                .catch(() => {})
                .finally(() => safe(() => record(c, 0, outcome)))
            } else record(c, 0, outcome)
          })
        },
      )
    } catch {
      /* ignore */
    }
    return p
  } as typeof fetch
  window.fetch = patched
  restoreFns.push(() => {
    if (window.fetch === patched) window.fetch = orig
    nativeFetch = null
  })
}

/** The fetch that was installed before dalil patched it (used by submit). */
export function getOriginalFetch(): typeof fetch {
  const f = nativeFetch ?? (typeof window !== 'undefined' ? window.fetch : fetch)
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    f.call(typeof window !== 'undefined' ? window : globalThis, input, init)) as typeof fetch
}

interface XhrState {
  method: string
  url: string
  headers: [string, string][]
  aborted?: boolean
}

function patchXhr() {
  if (typeof XMLHttpRequest === 'undefined') return
  const proto = XMLHttpRequest.prototype
  const origOpen = proto.open
  const origSend = proto.send
  const origSet = proto.setRequestHeader
  const origAbort = proto.abort
  const state = new WeakMap<XMLHttpRequest, XhrState>()

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    safe(() => state.set(this, { method: String(method || 'GET').toUpperCase(), url: absolute(String(url)), headers: [] }))
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof proto.open

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    safe(() => state.get(this)?.headers.push([name, value]))
    return origSet.call(this, name, value)
  }

  proto.abort = function (this: XMLHttpRequest) {
    safe(() => {
      const s = state.get(this)
      if (s) s.aborted = true
    })
    return origAbort.call(this)
  }

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    safe(() => {
      const s = state.get(this)
      if (!s || isOwnEndpoint(s.url)) return
      const info = headerInfo(s.headers)
      let requestId = info.requestId
      if (!requestId && isApiOrigin(s.url)) {
        requestId = uuid()
        origSet.call(this, 'X-Request-Id', requestId)
      }
      const d = describeBody(body, extraKeys())
      const ctx: ReqCtx = {
        method: s.method,
        rawUrl: s.url,
        url: redactUrl(s.url, extraKeys()),
        start: Date.now(),
        requestId,
        hadAuth: info.hadAuth,
        extraHeaders: info.extra,
        requestBody: d.body,
        requestContentType: info.contentType ?? d.contentType,
      }
      const xhr = this
      let done = false
      const finish = (kind: 'load' | 'error' | 'timeout' | 'abort') => {
        if (done) return
        done = true
        safe(() => {
          if (kind === 'abort' || s.aborted) return record(ctx, 0, 'aborted')
          if (kind === 'timeout') return record(ctx, 0, 'timeout')
          if (kind === 'error' || xhr.status === 0) return record(ctx, 0, 'network')
          let text: string | undefined
          const ct = xhr.getResponseHeader('content-type') ?? ''
          if (/[/+]json\b/i.test(ct)) {
            if (xhr.responseType === '' || xhr.responseType === 'text') text = xhr.responseText
            else if (xhr.responseType === 'json') text = JSON.stringify(xhr.response)
            if (text !== undefined && text.length > MAX_CLONE) text = undefined
          }
          const json = text !== undefined ? parseJson(text) : undefined
          const j = judge(xhr.status, json)
          const responseBody =
            text !== undefined ? redactJsonString(text, extraKeys()) : FAILED.has(j.outcome) ? '[not captured]' : undefined
          record(ctx, xhr.status, j.outcome, { responseBody, appCode: j.appCode, hasFieldErrors: j.hasFieldErrors })
        })
      }
      xhr.addEventListener('load', () => finish('load'))
      xhr.addEventListener('error', () => finish('error'))
      xhr.addEventListener('timeout', () => finish('timeout'))
      xhr.addEventListener('abort', () => finish('abort'))
    })
    return origSend.call(this, body as XMLHttpRequestBodyInit | null)
  }

  restoreFns.push(() => {
    proto.open = origOpen
    proto.send = origSend
    proto.setRequestHeader = origSet
    proto.abort = origAbort
  })
}

// ---------------- navigation ----------------

function currentUrl(): string {
  return redactUrl(location.pathname + location.search, extraKeys())
}

function recordNav() {
  safe(() => {
    const url = currentUrl()
    if (url === lastNavUrl) return
    push({ type: 'nav', url, from: lastNavUrl })
    lastNavUrl = url
  })
}

function patchHistory() {
  if (typeof history === 'undefined') return
  const origPush = history.pushState
  const origReplace = history.replaceState
  const pushP = function (this: History, ...args: Parameters<History['pushState']>) {
    const r = origPush.apply(this, args)
    recordNav()
    return r
  }
  const replaceP = function (this: History, ...args: Parameters<History['replaceState']>) {
    const r = origReplace.apply(this, args)
    recordNav()
    return r
  }
  history.pushState = pushP
  history.replaceState = replaceP
  restoreFns.push(() => {
    if (history.pushState === pushP) history.pushState = origPush
    if (history.replaceState === replaceP) history.replaceState = origReplace
  })
}

// ---------------- console ----------------

function patchConsole() {
  if (typeof console === 'undefined' || typeof console.error !== 'function') return
  const orig = console.error
  const patched = function (this: Console, ...args: unknown[]) {
    if (!inConsoleError) {
      inConsoleError = true
      safe(() => {
        const err = args.find((a) => a instanceof Error)
        const message = args.map((a) => truncate(stringify(a), 1000)).join(' ')
        pushError('console', message, err)
      })
      inConsoleError = false
    }
    return orig.apply(this, args)
  }
  console.error = patched
  restoreFns.push(() => {
    if (console.error === patched) console.error = orig
  })
}

// ---------------- public API ----------------

function listen(target: EventTarget, type: string, fn: (e: Event) => void, capture: boolean) {
  target.addEventListener(type, fn, capture)
  restoreFns.push(() => target.removeEventListener(type, fn, capture))
}

export function init(cfg: DalilConfig): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const first = config === null
  config = { ...cfg }
  if (!first) return
  const steps: (() => void)[] = [
    restoreMirror,
    patchFetch,
    patchXhr,
    patchHistory,
    patchConsole,
    () => listen(document, 'click', onClick, true),
    () => listen(document, 'input', onInput, true),
    () => listen(document, 'change', onInput, true),
    () => listen(document, 'submit', onSubmit, true),
    () => listen(window, 'error', onWindowError, true),
    () => listen(window, 'unhandledrejection', onRejection, false),
    () => listen(window, 'popstate', recordNav, false),
    () => listen(window, 'pagehide', () => safe(() => config && writeMirror()), false),
    () => {
      const last = [...events].reverse().find((e) => e.type === 'nav')
      lastNavUrl = last?.type === 'nav' ? last.url : undefined
      recordNav()
    },
    () => {
      setTimeout(() => {
        flushPending().catch(() => {})
      }, 0)
    },
  ]
  for (const s of steps) safe(s)
}

export function getConfig(): DalilConfig | null {
  return config
}

export function log(msg: string, data?: unknown, level: 'info' | 'warn' | 'error' = 'info'): void {
  safe(() => {
    let d: string | undefined
    if (data !== undefined) {
      let s: string
      try {
        s = typeof data === 'string' ? data : (JSON.stringify(data) ?? String(data))
      } catch {
        s = String(data)
      }
      d = redactJsonString(s, extraKeys(), 5 * 1024)
    }
    push({ type: 'log', level, message: truncate(redactText(String(msg)), 2000), data: d })
  })
}

export function snapshot(): { events: DalilEvent[]; verdict: Verdict; curls: Record<string, string> } {
  prune()
  const list = events.map((e) => ({ ...e }) as DalilEvent)
  const curls: Record<string, string> = {}
  for (const e of list) {
    if (e.type === 'request' && FAILED.has(e.outcome) && !e.refreshed) {
      try {
        curls[e.id] = toCurl(e)
      } catch {
        /* ignore */
      }
    }
  }
  return { events: list, verdict: classify(list, Date.now()), curls }
}

export function open(): void {
  for (const cb of [...openListeners]) safe(cb)
}

export function onOpen(cb: () => void): () => void {
  openListeners.add(cb)
  return () => {
    openListeners.delete(cb)
  }
}

export function __resetForTests(): void {
  for (const r of restoreFns.reverse()) safe(r)
  restoreFns = []
  if (mirrorTimer) clearTimeout(mirrorTimer)
  mirrorTimer = null
  lastMirrorWrite = 0
  config = null
  events = []
  lastNavUrl = undefined
  lastInput.clear()
  openListeners.clear()
  nativeFetch = null
  safe(() => storage()?.removeItem(STORAGE_KEY))
}
