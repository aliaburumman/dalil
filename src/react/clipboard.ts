// Copy a Share (rich HTML + plain text) to the clipboard. Starts synchronously so the click gesture is valid.
import type { Share } from '../core'

export function copyShare(share: Share, done: (ok: boolean) => void): void {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const text = () => {
    if (!clip?.writeText) return done(false)
    clip.writeText(share.text).then(() => done(true), () => done(false))
  }
  if (typeof ClipboardItem !== 'undefined' && clip?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([share.html], { type: 'text/html' }),
        'text/plain': new Blob([share.text], { type: 'text/plain' }),
      })
      clip.write([item]).then(() => done(true), text)
      return
    } catch {
      /* fall through to plain text */
    }
  }
  text()
}
