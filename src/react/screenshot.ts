// Lazy chunk: viewport screenshot via html-to-image. Loaded only when the widget
// is about to open (or preloaded on hover/focus/shortcut).
import { toJpeg } from 'html-to-image'

const TIMEOUT_MS = 4000
const MASK_CLASS = 'dalil-capturing'
const MASK_STYLE_ID = 'dalil-mask-style'

// html-to-image has no onclone hook and reads computed styles from the LIVE DOM,
// so masking is done by flipping a class on <html> for the duration of the capture.
// Masked elements keep their box (layout doesn't shift) but render as a grey block.
const MASK_CSS = `
.${MASK_CLASS} [data-dalil-mask],.${MASK_CLASS} iframe{background:#9ca3af !important;background-image:none !important;color:transparent !important;border-color:#9ca3af !important;box-shadow:none !important}
.${MASK_CLASS} [data-dalil-mask] *{visibility:hidden !important}
`

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

/** Captures the visible viewport as a JPEG data URL. Rejects on failure or after 4 s. */
export async function captureScreenshot(): Promise<string> {
  const root = document.documentElement
  const style = document.createElement('style')
  style.id = MASK_STYLE_ID
  style.textContent = MASK_CSS
  document.head.appendChild(style)
  root.classList.add(MASK_CLASS)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const w = window.innerWidth
    const h = window.innerHeight
    const capture = toJpeg(root, {
      quality: 0.7,
      width: w,
      height: h,
      canvasWidth: w,
      canvasHeight: h,
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
      filter: (node) => !isIgnored(node) && !isBelowViewport(node, h),
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Screenshot timed out after 4s')), TIMEOUT_MS)
    })
    return await Promise.race([capture, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    root.classList.remove(MASK_CLASS)
    style.remove()
  }
}
