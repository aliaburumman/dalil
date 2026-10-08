// Lazy chunk: viewport screenshot via html-to-image. Loaded only when the widget
// is about to open (or preloaded on hover/focus/shortcut).
import { toJpeg } from 'html-to-image'

const BUDGET_MS = 4000
const MASK_CLASS = 'dalil-capturing'
const MASK_STYLE_ID = 'dalil-mask-style'
const XO_ATTR = 'data-dalil-xo-bg'
const XO_BG_SCAN_CAP = 1500

// html-to-image has no onclone hook and reads computed styles from the LIVE DOM.
// Manual (on-open) captures mask by flipping a class on <html> for the duration:
// masked elements keep their box but render as a grey block. Auto captures must be
// invisible (and not show up in the replay), so they mask through the filter only.
const MASK_CSS = `
.${MASK_CLASS} [data-dalil-mask],.${MASK_CLASS} iframe{background:#9ca3af !important;background-image:none !important;color:transparent !important;border-color:#9ca3af !important;box-shadow:none !important}
.${MASK_CLASS} [data-dalil-mask] *{visibility:hidden !important}
`
const XO_CSS = `[${XO_ATTR}]{background-image:none !important}\n`

export interface CaptureOptions {
  /** Failure-moment capture: filter-only masking, JPEG 0.5, width capped at 1280. */
  auto?: boolean
}

function isIgnored(node: unknown): boolean {
  return (
    typeof Element !== 'undefined' &&
    node instanceof Element &&
    node.hasAttribute('data-dalil-ignore')
  )
}

function isBelowViewport(node: unknown, viewportH: number): boolean {
  if (typeof Element === 'undefined' || !(node instanceof Element)) return false
  if (node === document.documentElement || node === document.body) return false
  const r = node.getBoundingClientRect()
  return r.height > 0 && r.top > viewportH + 50
}

function isMasked(node: unknown): boolean {
  return (
    typeof Element !== 'undefined' &&
    node instanceof Element &&
    (node.hasAttribute('data-dalil-mask') || node.tagName === 'IFRAME')
  )
}

function crossOrigin(url: string | null | undefined): boolean {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false
  try {
    return new URL(url, location.href).origin !== location.origin
  } catch {
    return false
  }
}

/** Cross-origin media that html-to-image would have to fetch (and can't without CORS). */
function isCrossOriginMedia(node: unknown): boolean {
  if (typeof Element === 'undefined' || !(node instanceof Element)) return false
  const tag = node.tagName.toLowerCase()
  if (tag === 'img') {
    const img = node as HTMLImageElement
    if (img.crossOrigin) return false
    return crossOrigin(img.currentSrc || img.src || img.getAttribute('src'))
  }
  if (tag === 'video') {
    const v = node as HTMLVideoElement
    if (v.crossOrigin) return false
    return crossOrigin(v.currentSrc || v.src) || crossOrigin(v.poster)
  }
  if (tag === 'image') {
    // <svg><image href=…>
    return crossOrigin(node.getAttribute('href') ?? node.getAttribute('xlink:href'))
  }
  if (tag === 'source' && node.parentElement?.tagName.toLowerCase() === 'picture') {
    const first = (node.getAttribute('srcset') ?? '').trim().split(/[\s,]+/)[0]
    return crossOrigin(first)
  }
  return false
}

function hasCrossOriginBackground(value: string): boolean {
  const re = /url\((['"]?)(.*?)\1\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value))) if (crossOrigin(m[2])) return true
  return false
}

/** Tags in-viewport elements whose CSS background-image is cross-origin; returns the cleanup. */
function tagCrossOriginBackgrounds(viewportH: number): () => void {
  const tagged: Element[] = []
  const all = document.querySelectorAll('*')
  const n = Math.min(all.length, XO_BG_SCAN_CAP)
  for (let i = 0; i < n; i++) {
    const el = all[i]!
    const r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.top > viewportH || r.height === 0) continue
    const bg = getComputedStyle(el).backgroundImage
    if (bg && bg.includes('url(') && hasCrossOriginBackground(bg)) {
      el.setAttribute(XO_ATTR, '')
      tagged.push(el)
    }
  }
  return () => {
    for (const el of tagged) el.removeAttribute(XO_ATTR)
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error && err.message) return err
  if (typeof Event !== 'undefined' && err instanceof Event) return new Error('An image or resource failed to load')
  return new Error(typeof err === 'string' && err ? err : 'Screenshot failed')
}

/**
 * Captures the visible viewport as a JPEG data URL. One 4 s budget covers two attempts:
 * attempt 1 as-is; if it rejects, attempt 2 leaves out cross-origin images/backgrounds
 * (which is what makes html-to-image reject when the host has no CORS headers).
 */
export async function captureScreenshot(opts: CaptureOptions = {}): Promise<string> {
  const auto = !!opts.auto
  const deadline = Date.now() + BUDGET_MS
  const root = document.documentElement
  const w = window.innerWidth
  const h = window.innerHeight
  const scale = auto ? Math.min(1, 1280 / Math.max(w, 1)) : 1
  const style = document.createElement('style')
  style.id = MASK_STYLE_ID
  style.setAttribute('data-dalil-ignore', '')
  style.textContent = (auto ? '' : MASK_CSS) + XO_CSS
  let styleAttached = false
  const attach = () => {
    if (styleAttached) return
    document.head.appendChild(style)
    styleAttached = true
  }
  let untag: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const run = (excludeXo: boolean) => {
    const capture = toJpeg(root, {
      quality: auto ? 0.5 : 0.7,
      width: w,
      height: h,
      canvasWidth: Math.round(w * scale),
      canvasHeight: Math.round(h * scale),
      pixelRatio: 1,
      skipFonts: true,
      cacheBust: false,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      style: {
        transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
        transformOrigin: 'top left',
      },
      // Skip widget roots, and anything entirely below the viewport: it can't
      // appear in the crop, and dropping it keeps long tables under the timeout.
      // (Content ABOVE the viewport must stay or the crop would shift.)
      filter: (node) =>
        !isIgnored(node) &&
        !isBelowViewport(node, h) &&
        !(auto && isMasked(node)) &&
        !(excludeXo && isCrossOriginMedia(node)),
    })
    const remaining = Math.max(0, deadline - Date.now())
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Screenshot timed out after 4s')), remaining)
    })
    return Promise.race([capture, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  try {
    if (!auto) {
      attach()
      root.classList.add(MASK_CLASS)
    }
    try {
      return await run(false)
    } catch (first) {
      const err = toError(first)
      if (err.message.includes('timed out') || Date.now() >= deadline - 50) throw err
      try {
        attach()
        untag = tagCrossOriginBackgrounds(h)
        return await run(true)
      } catch (second) {
        throw toError(second)
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
    untag?.()
    if (!auto) root.classList.remove(MASK_CLASS)
    if (styleAttached) style.remove()
  }
}
