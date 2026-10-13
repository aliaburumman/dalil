// The host's CSP nonce (config.cspNonce), shared with lazily loaded modules (screenshot) that
// add styles to the page document.
let nonce: string | undefined

export function setCspNonce(value: string | undefined): void {
  nonce = value || undefined
}

export function getCspNonce(): string | undefined {
  return nonce
}

/**
 * Adds CSS to the page document until the returned function is called. Uses a constructed
 * stylesheet when the browser supports it (not blocked by a strict `style-src`), else a
 * <style> element carrying the configured nonce.
 */
export function addDocumentStyle(css: string, id: string): () => void {
  const doc = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] }
  if (Array.isArray(doc.adoptedStyleSheets) && typeof CSSStyleSheet !== 'undefined') {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      return () => {
        doc.adoptedStyleSheets = (doc.adoptedStyleSheets ?? []).filter((s) => s !== sheet)
      }
    } catch {
      /* not constructable here: fall back to <style> */
    }
  }
  const el = document.createElement('style')
  el.id = id
  el.setAttribute('data-dalil-ignore', '')
  if (nonce) el.nonce = nonce
  el.textContent = css
  document.head.appendChild(el)
  return () => el.remove()
}
