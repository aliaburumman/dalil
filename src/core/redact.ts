// Pure redaction helpers. Everything the recorder stores or sends passes through here.

export const REDACTED = '[REDACTED]'
export const MAX_BODY = 10 * 1024
export const TRUNCATED = '…[truncated]'

const SECRET_KEYS = [
  'password',
  'pass',
  'otp',
  'pin',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'cvv',
  'cardnumber',
  'iban',
]

const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g
const BEARER_RE = /\bBearer\s+(?!\[REDACTED\])[^\s"',;]+/gi
const SECRET_HEADER_RE = /token|secret|key|session|auth|cookie|password|signature|csrf/i

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** "accessToken" → ["access","token"], "card_number" → ["card","number"], "X-Api-Key" → ["x","api","key"] */
function segments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

/**
 * Anchored key match: the whole key (separators removed) or any one camelCase /
 * snake / kebab segment must equal a secret word. `isPinned`, `shipping` and
 * `spinner` therefore stay visible.
 */
export function isSecretKey(key: string, extraKeys?: string[]): boolean {
  const words = extraKeys?.length ? SECRET_KEYS.concat(extraKeys.map(norm)) : SECRET_KEYS
  const whole = norm(key)
  if (!whole) return false
  if (words.includes(whole)) return true
  return segments(key).some((s) => words.includes(s))
}

/** JWT → [JWT], "Bearer x" → "Bearer [REDACTED]". */
export function redactText(text: string): string {
  if (typeof text !== 'string' || !text) return text
  return text.replace(JWT_RE, '[JWT]').replace(BEARER_RE, `Bearer ${REDACTED}`)
}

export function truncate(s: string, max = MAX_BODY): string {
  return s.length > max ? s.slice(0, max) + TRUNCATED : s
}

function redactValue(v: unknown, extraKeys: string[] | undefined, depth: number): unknown {
  if (typeof v === 'string') return redactText(v)
  if (v === null || typeof v !== 'object') return v
  if (depth > 50) return '[too deep]'
  if (Array.isArray(v)) return v.map((x) => redactValue(x, extraKeys, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] =
      isSecretKey(k, extraKeys) && val !== null && val !== undefined && val !== ''
        ? REDACTED
        : redactValue(val, extraKeys, depth + 1)
  }
  return out
}

/** Redacts an already-parsed value (objects, arrays, strings). */
export function redactObject<T>(value: T, extraKeys?: string[]): T {
  return redactValue(value, extraKeys, 0) as T
}

const FORM_ENCODED_RE = /^[^\s=&{}[\]"]+=[^\s&]*(?:&[^\s=&{}[\]"]+=[^\s&]*)*$/

function redactQueryString(qs: string, extraKeys?: string[]): string {
  return qs
    .split('&')
    .map((pair) => {
      if (!pair) return pair
      const i = pair.indexOf('=')
      const rawKey = i === -1 ? pair : pair.slice(0, i)
      if (i === -1) return redactText(pair)
      let key = rawKey
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
      } catch {
        /* keep raw */
      }
      if (isSecretKey(key, extraKeys)) return `${rawKey}=${REDACTED}`
      return `${rawKey}=${redactText(pair.slice(i + 1))}`
    })
    .join('&')
}

/**
 * Parses JSON when possible and redacts secret keys at any depth; otherwise
 * treats form-encoded text by key and anything else as free text. Always
 * scrubs JWT/Bearer values and truncates to 10 KB.
 */
export function redactJsonString(str: string, extraKeys?: string[], max = MAX_BODY): string {
  if (typeof str !== 'string') return str
  let out: string
  const trimmed = str.trim()
  let parsed: unknown
  let isJson = false
  if (trimmed && /^[[{"]/.test(trimmed)) {
    try {
      parsed = JSON.parse(trimmed)
      isJson = true
    } catch {
      /* not JSON */
    }
  }
  if (isJson) out = JSON.stringify(redactValue(parsed, extraKeys, 0))
  else if (FORM_ENCODED_RE.test(trimmed)) out = redactQueryString(trimmed, extraKeys)
  else out = redactText(str)
  return truncate(out, max)
}

/** Redacts query params by key, scrubs JWTs, drops the hash. Relative input stays relative. */
export function redactUrl(url: string, extraKeys?: string[]): string {
  if (typeof url !== 'string') return url
  try {
    const noHash = url.split('#')[0] ?? ''
    const q = noHash.indexOf('?')
    const base = q === -1 ? noHash : noHash.slice(0, q)
    const search = q === -1 ? '' : noHash.slice(q + 1)
    const red = search ? '?' + redactQueryString(search, extraKeys) : ''
    return redactText(base) + red
  } catch {
    return redactText(url)
  }
}

type HeaderLike = Headers | Record<string, string> | [string, string][] | undefined | null

export function headerEntries(h: HeaderLike | HeadersInit): [string, string][] {
  if (!h) return []
  try {
    if (typeof (h as Headers).forEach === 'function' && typeof (h as Headers).get === 'function') {
      const out: [string, string][] = []
      ;(h as Headers).forEach((v, k) => out.push([k, v]))
      return out
    }
    if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)])
    return Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)])
  } catch {
    return []
  }
}

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADER_RE.test(name)
}

/** Authorization, Cookie and anything token/secret/key/session-like → [REDACTED]. */
export function redactHeaders(h: HeaderLike | HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headerEntries(h)) {
    out[k] = isSecretHeader(k) ? REDACTED : redactText(v)
  }
  return out
}

// ---------- body descriptors ----------

const tag = (v: unknown) => Object.prototype.toString.call(v)

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '? KB'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function isFormData(v: unknown): v is FormData {
  return tag(v) === '[object FormData]'
}
export function isBlob(v: unknown): v is Blob {
  const t = tag(v)
  return t === '[object Blob]' || t === '[object File]'
}

export function describeFile(b: Blob): string {
  const name = (b as File).name
  return name ? `[file: ${name}, ${formatSize(b.size)}]` : `[blob: ${b.type || 'binary'}, ${formatSize(b.size)}]`
}

/** "[multipart] amount, note, receipt=[file: receipt.jpg, 214 KB]" — field names only, never values. */
export function describeFormData(fd: FormData): string {
  const parts: string[] = []
  try {
    fd.forEach((value, key) => {
      parts.push(isBlob(value) ? `${key}=${describeFile(value)}` : key)
    })
  } catch {
    /* ignore */
  }
  return `[multipart] ${parts.join(', ')}`.trim()
}

/**
 * Describes a fetch/XHR body as a redacted string. Returns the content type
 * fetch would infer when it can tell.
 */
export function describeBody(
  body: unknown,
  extraKeys?: string[],
): { body?: string; contentType?: string } {
  if (body === undefined || body === null) return {}
  try {
    if (typeof body === 'string') return { body: redactJsonString(body, extraKeys) }
    const t = tag(body)
    if (t === '[object URLSearchParams]')
      return {
        body: redactJsonString(String(body), extraKeys),
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      }
    if (isFormData(body)) return { body: describeFormData(body), contentType: 'multipart/form-data' }
    if (isBlob(body)) return { body: describeFile(body), contentType: body.type || undefined }
    if (t === '[object ArrayBuffer]' || ArrayBuffer.isView(body))
      return { body: `[binary: ${formatSize((body as ArrayBuffer).byteLength)}]` }
    if (t === '[object Document]') return { body: '[not captured]' }
    return { body: '[not captured]' }
  } catch {
    return { body: '[not captured]' }
  }
}
