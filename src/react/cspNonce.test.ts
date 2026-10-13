import { afterEach, describe, expect, it } from 'vitest'
import { addDocumentStyle, setCspNonce } from './cspNonce'

type Doc = Document & { adoptedStyleSheets?: CSSStyleSheet[] }

afterEach(() => {
  setCspNonce(undefined)
  Reflect.deleteProperty(document, 'adoptedStyleSheets')
})

describe('addDocumentStyle', () => {
  it('falls back to a <style> with the nonce, and removes it', () => {
    setCspNonce('abc123')
    const detach = addDocumentStyle('.x{color:red}', 'dalil-mask-style')
    const el = document.getElementById('dalil-mask-style') as HTMLStyleElement
    expect(el.nonce).toBe('abc123')
    expect(el.textContent).toBe('.x{color:red}')
    detach()
    expect(document.getElementById('dalil-mask-style')).toBeNull()
  })

  it('uses a constructed stylesheet when the document supports it (no <style> element)', () => {
    class FakeSheet {
      css = ''
      replaceSync(css: string) {
        this.css = css
      }
    }
    const original = globalThis.CSSStyleSheet
    globalThis.CSSStyleSheet = FakeSheet as unknown as typeof CSSStyleSheet
    try {
      ;(document as Doc).adoptedStyleSheets = []
      const detach = addDocumentStyle('.x{color:red}', 'dalil-mask-style')
      expect(document.getElementById('dalil-mask-style')).toBeNull()
      expect((document as Doc).adoptedStyleSheets).toHaveLength(1)
      expect(((document as Doc).adoptedStyleSheets![0] as unknown as FakeSheet).css).toBe('.x{color:red}')
      detach()
      expect((document as Doc).adoptedStyleSheets).toHaveLength(0)
    } finally {
      globalThis.CSSStyleSheet = original
    }
  })
})
