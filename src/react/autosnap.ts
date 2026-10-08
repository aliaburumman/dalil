// Lazy chunk: automatic screenshots at failure moments (failed request, error event,
// error toast). Memory-only ring of the last 3; nothing is persisted.
import { LIMITS, getConfig, log, onEvent, redactText, type AutoSnapReason, type DalilEvent } from '../core'

export interface AutoSnap {
  t: number
  reason: AutoSnapReason
  /** e.g. "Error toast: Failed to save payment" */
  label: string
  eventId?: string
  dataUrl: string
}

export const DEFAULT_TOAST_SELECTORS = [
  '[data-sonner-toast][data-type="error"]',
  '.toast-error',
  '.Toastify__toast--error',
  '.notistack-MuiContent-error',
  '.dalil-error',
]
const TOAST_DELAY_MS = 300
const EVENT_DELAY_MS = 700
const THROTTLE_MS = 4000
const SLOW_MS = 800
const DEDUPE_MS = 10_000
const REFRESH_WAIT_MS = 5200
const MAX_TOAST_CHARS = 200
const FAILED = new Set(['http_error', 'app_error', 'network', 'timeout'])

let ring: AutoSnap[] = []

/** Snapshots currently held, oldest first. */
export function getAutoSnaps(): AutoSnap[] {
  return [...ring]
}

export function removeAutoSnap(snap: AutoSnap): void {
  ring = ring.filter((s) => s !== snap)
}

export function __resetAutoSnapsForTests(): void {
  ring = []
}

const approxBytes = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4)

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const t = setTimeout(() => reject(new Error('decode timed out')), 2000)
    img.onload = () => {
      clearTimeout(t)
      resolve(img)
    }
    img.onerror = () => {
      clearTimeout(t)
      reject(new Error('decode failed'))
    }
    img.src = src
  })
}

/** Re-encodes a JPEG data URL smaller until it fits `max` bytes; null when it cannot. */
export async function fitUnder(dataUrl: string, max: number): Promise<string | null> {
  if (approxBytes(dataUrl) <= max) return dataUrl
  try {
    const img = await loadImg(dataUrl)
    let scale = 1
    let quality = 0.4
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * scale))
      c.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = c.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, c.width, c.height)
      const out = c.toDataURL('image/jpeg', quality)
      if (approxBytes(out) <= max) return out
      quality = Math.max(0.25, quality - 0.05)
      scale *= 0.75
    }
  } catch {
    /* fall through */
  }
  return null
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

interface Trigger {
  reason: AutoSnapReason
  label: string
  eventId?: string
  delay: number
}

export interface AutoSnapOptions {
  /** Test seam; defaults to the lazy screenshot chunk. */
  capture?: () => Promise<string>
  now?: () => number
}

/** Starts watching. Returns a stop function. Safe to call in SSR (no-op). */
export function startAutoSnap(opts: AutoSnapOptions = {}): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const now = opts.now ?? Date.now
  const capture =
    opts.capture ?? (() => import('./screenshot').then((m) => m.captureScreenshot({ auto: true })))
  let stopped = false
  let slowPage = false
  let capturing = false
  let lastStart = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Trigger | undefined
  const toastSelector = (getConfig()?.toastSelectors?.length ? getConfig()!.toastSelectors! : DEFAULT_TOAST_SELECTORS).join(', ')
  const seenToasts = new Map<string, number>()
  let loggingToast = false
  let lastToastEventId: string | undefined

  const fire = async () => {
    timer = undefined
    const trig = pending
    pending = undefined
    if (!trig || stopped || slowPage || capturing) return
    if (document.hidden) return
    if (now() - lastStart < THROTTLE_MS) return
    capturing = true
    lastStart = now()
    const t0 = performance.now()
    try {
      const raw = await capture()
      const took = performance.now() - t0
      if (took > SLOW_MS) slowPage = true
      if (stopped) return
      const fitted = await fitUnder(raw, LIMITS.autoSnapBytes)
      if (!fitted) return
      ring.push({ t: Date.now(), reason: trig.reason, label: trig.label, eventId: trig.eventId, dataUrl: fitted })
      if (ring.length > LIMITS.autoSnaps) ring = ring.slice(ring.length - LIMITS.autoSnaps)
    } catch {
      /* a failed auto-capture is silent; the on-open screenshot still exists */
    } finally {
      capturing = false
    }
  }

  const schedule = (trig: Trigger) => {
    if (stopped || slowPage || document.hidden) return
    if (now() - lastStart < THROTTLE_MS) return
    // A toast is the most informative moment: it replaces a pending request/error snap.
    if (pending && pending.reason === 'toast' && trig.reason !== 'toast') return
    pending = trig
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void fire(), trig.delay)
  }

  const offEvent = onEvent((e: DalilEvent) => {
    if (e.type === 'log') {
      if (loggingToast) lastToastEventId = e.id
      return
    }
    if (e.type === 'request') {
      if (!FAILED.has(e.outcome)) return
      const label = `${e.method} ${pathOf(e.url)} → ${e.status || e.outcome}`
      const trig: Trigger = { reason: 'request', label, eventId: e.id, delay: EVENT_DELAY_MS }
      if (e.status === 401) {
        // A 401 followed by a successful retry is a silent token refresh, not a failure.
        setTimeout(() => {
          if (!e.refreshed) schedule(trig)
        }, REFRESH_WAIT_MS)
      } else {
        schedule(trig)
      }
      return
    }
    if (e.type === 'error') {
      schedule({ reason: 'error', label: `Error: ${e.message.slice(0, 120)}`, eventId: e.id, delay: EVENT_DELAY_MS })
    }
  })

  const onToast = (el: Element) => {
    const text = (((el as HTMLElement).innerText || el.textContent) ?? '').replace(/\s+/g, ' ').trim()
    const key = el.getAttribute('data-id') || text
    if (!key) return
    const t = now()
    const prev = seenToasts.get(key)
    if (prev !== undefined && t - prev < DEDUPE_MS) return
    seenToasts.set(key, t)
    if (seenToasts.size > 50) for (const [k, v] of seenToasts) if (t - v >= DEDUPE_MS) seenToasts.delete(k)
    const clean = redactText(text).slice(0, MAX_TOAST_CHARS)
    lastToastEventId = undefined
    loggingToast = true
    try {
      log(`Toast: ${clean}`, undefined, 'error', 'toast')
    } finally {
      loggingToast = false
    }
    schedule({ reason: 'toast', label: `Error toast: ${clean}`, eventId: lastToastEventId, delay: TOAST_DELAY_MS })
  }

  const scan = (node: Node) => {
    if (!(node instanceof Element)) return
    try {
      if (node.matches(toastSelector)) onToast(node)
      node.querySelectorAll(toastSelector).forEach(onToast)
    } catch {
      /* an invalid host selector must never break the page */
    }
  }

  const safeMatches = (el: Element) => {
    try {
      return el.matches(toastSelector)
    } catch {
      return false
    }
  }

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(scan)
      else if (r.type === 'attributes' && r.target instanceof Element && safeMatches(r.target)) {
        onToast(r.target)
      }
    }
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-type', 'class'] })

  return () => {
    stopped = true
    offEvent()
    mo.disconnect()
    if (timer) clearTimeout(timer)
    pending = undefined
  }
}
