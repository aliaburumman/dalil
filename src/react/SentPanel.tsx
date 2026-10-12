// Persistent confirmation after a successful submit: reference, Copy report, Done.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { SubmitResult } from '../core'
import { defaultLabels, fmt, type Labels } from './labels'
import { rootAttrs, type Appearance } from './styles'

export interface SentPanelProps extends Appearance {
  result: SubmitResult
  labels: Labels
  dir: 'ltr' | 'rtl'
  onClose: () => void
}

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select,textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function activeIn(node: Element | null): HTMLElement | null {
  const root = node?.getRootNode?.() as Document | ShadowRoot | undefined
  return ((root && 'activeElement' in root ? root.activeElement : document.activeElement) as HTMLElement | null) ?? null
}

export function SentPanel({ result, labels, dir, onClose, theme, accent, accentForeground }: SentPanelProps) {
  const ids = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const share = result.share
  const L = (k: 'copyReport' | 'copied' | 'copyFailed' | 'done') => labels[k] ?? defaultLabels[k]!

  // Same focus handling as Dialog: the Dialog's cleanup has already restored focus to the opener
  // by the time this runs, so `prev` is the opener and we hand focus back to it on close.
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

  useEffect(() => () => clearTimeout(timer.current), [])

  const flash = (s: 'copied' | 'failed') => {
    setStatus(s)
    clearTimeout(timer.current)
    if (s === 'copied') timer.current = setTimeout(() => setStatus('idle'), 2000)
  }

  // Clipboard calls start synchronously inside the click so the user gesture is still valid.
  const copy = () => {
    if (!share) return
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    const text = () => {
      if (!clip?.writeText) return flash('failed')
      clip.writeText(share.text).then(() => flash('copied'), () => flash('failed'))
    }
    if (typeof ClipboardItem !== 'undefined' && clip?.write) {
      try {
        const item = new ClipboardItem({
          'text/html': new Blob([share.html], { type: 'text/html' }),
          'text/plain': new Blob([share.text], { type: 'text/plain' }),
        })
        clip.write([item]).then(() => flash('copied'), text)
        return
      } catch {
        /* fall through to plain text */
      }
    }
    text()
  }

  // Escape is handled by the document listener above; this only traps Tab.
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

  return (
    <div
      className="dalil-root dalil-backdrop"
      data-dalil-ignore=""
      dir={dir}
      {...rootAttrs({ theme, accent, accentForeground })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={rootRef}
        className="dalil-dialog dalil-sent"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        dir={dir}
        onKeyDown={onKeyDown}
      >
        <div className="dalil-head">
          <h2 id={`${ids}-title`}>{fmt(labels.sentAs, { ref: result.ref })}</h2>
        </div>
        <p className="dalil-status" role="status" aria-live="polite">
          {status === 'copied' ? L('copied') : status === 'failed' ? L('copyFailed') : ''}
        </p>
        <div className="dalil-actions">
          {share && (
            <button ref={firstRef} type="button" className="dalil-btn" onClick={copy}>
              {status === 'copied' ? L('copied') : L('copyReport')}
            </button>
          )}
          <button ref={share ? undefined : firstRef} type="button" className="dalil-btn dalil-primary" onClick={onClose}>
            {L('done')}
          </button>
        </div>
      </div>
    </div>
  )
}
