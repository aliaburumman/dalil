// Focus + Escape + Tab trap shared by the Azure DevOps panels (same pattern as SentPanel).
import { useLayoutEffect, useRef } from 'react'

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select,textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function activeIn(node: Element | null): HTMLElement | null {
  const root = node?.getRootNode?.() as Document | ShadowRoot | undefined
  return ((root && 'activeElement' in root ? root.activeElement : document.activeElement) as HTMLElement | null) ?? null
}

export function usePanel(onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const root = rootRef.current?.getRootNode?.() as Document | ShadowRoot | undefined
    const doc = rootRef.current?.ownerDocument ?? document
    const own = activeIn(rootRef.current)
    const prev = own && own !== doc.body ? own : root && 'host' in root ? (doc.activeElement as HTMLElement | null) : own
    firstRef.current?.focus()
    return () => prev?.focus?.()
  }, [])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const doc = rootRef.current?.ownerDocument ?? document
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
      closeRef.current()
    }
    doc.addEventListener('keydown', onDocKey, true)
    return () => doc.removeEventListener('keydown', onDocKey, true)
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !rootRef.current) return
    const items = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = activeIn(rootRef.current)
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return { rootRef, firstRef, onKeyDown }
}
