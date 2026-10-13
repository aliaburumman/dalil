import { afterEach, describe, expect, it } from 'vitest'
import { ensureStyles } from './styles'

function shadow(): ShadowRoot {
  const h = document.createElement('div')
  document.body.appendChild(h)
  return h.attachShadow({ mode: 'open' })
}
const proto = ShadowRoot.prototype as unknown as Record<string, unknown>
const savedSheet = globalThis.CSSStyleSheet
afterEach(() => {
  delete proto.adoptedStyleSheets
  globalThis.CSSStyleSheet = savedSheet
  document.head.innerHTML = ''
})

describe('ensureStyles', () => {
  it('adopts a constructed stylesheet in a shadow root when supported (no <style>)', () => {
    proto.adoptedStyleSheets = []
    class Sheet {
      css = ''
      replaceSync(c: string) {
        this.css = c
      }
    }
    globalThis.CSSStyleSheet = Sheet as unknown as typeof CSSStyleSheet
    const root = shadow()
    Object.defineProperty(root, 'adoptedStyleSheets', { value: [], writable: true, configurable: true })
    ensureStyles(root, 'n1')
    ensureStyles(root, 'n1')
    const adopted = root.adoptedStyleSheets as unknown[]
    expect(adopted).toHaveLength(1)
    expect((adopted[0] as Sheet).css).toContain('.dalil-fab')
    expect(root.querySelector('style')).toBeNull()
  })

  it('falls back to <style nonce> in a shadow root without adoptedStyleSheets', () => {
    const root = shadow()
    ensureStyles(root, 'abc')
    ensureStyles(root, 'abc')
    const styles = root.querySelectorAll('style')
    expect(styles).toHaveLength(1)
    expect(styles[0]!.getAttribute('nonce')).toBe('abc')
  })

  it('light DOM uses <style nonce> in head, once', () => {
    ensureStyles(undefined, 'xyz')
    ensureStyles(undefined, 'xyz')
    const styles = document.head.querySelectorAll('style#dalil-styles')
    expect(styles).toHaveLength(1)
    expect(styles[0]!.getAttribute('nonce')).toBe('xyz')
  })

  it('omits nonce when none is given', () => {
    ensureStyles(undefined)
    expect(document.head.querySelector('style')!.hasAttribute('nonce')).toBe(false)
  })
})
