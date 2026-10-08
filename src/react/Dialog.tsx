// Lazy chunk: the report dialog. Rendered only after the screenshot attempt finished.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  PAYLOAD_VERSION,
  redactUrl,
  submit,
  type DalilEvent,
  type Environment,
  type ReportContext,
  type ReportPayload,
  type Severity,
  type Verdict,
} from '../core'
import { Annotator, type AnnotatorHandle } from './Annotator'
import { ImagePicker, type PickedImage } from './ImagePicker'
import { fmt, type Labels } from './labels'

export interface DialogSnapshot {
  events: DalilEvent[]
  verdict: Verdict
  curls: Record<string, string>
}

export interface DialogProps {
  project: string
  labels: Labels
  dir: 'ltr' | 'rtl'
  getContext?: () => ReportContext
  snap: DialogSnapshot
  screenshot: { dataUrl?: string; error?: string }
  onClose: () => void
  onToast: (message: string) => void
}

const STEP_TYPES = new Set(['nav', 'click', 'input', 'submit'])

function safeContext(get?: () => ReportContext): ReportContext {
  try {
    return get?.() ?? {}
  } catch {
    return {}
  }
}

function buildEnv(): Environment {
  let url = location.origin + location.pathname + location.search
  try {
    url = redactUrl(url)
  } catch {
    url = location.origin + location.pathname
  }
  return {
    url,
    userAgent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    online: navigator.onLine,
  }
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code
    return typeof c === 'string' ? c : undefined
  }
  return undefined
}

const FOCUSABLE =
  'button:not([disabled]),[href],input:not([disabled]),select,textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary'

export function Dialog({ project, labels, dir, getContext, snap, screenshot, onClose, onToast }: DialogProps) {
  const ids = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLTextAreaElement>(null)
  const annotatorRef = useRef<AnnotatorHandle>(null)
  const [title, setTitle] = useState('')
  const [expected, setExpected] = useState('')
  const [severity, setSeverity] = useState<Severity>('annoying')
  const [images, setImages] = useState<PickedImage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const context = useMemo(() => safeContext(getContext), [getContext])

  const counts = useMemo(() => {
    let steps = 0
    let requests = 0
    let failed = 0
    for (const e of snap.events) {
      if (STEP_TYPES.has(e.type)) steps++
      if (e.type === 'request') {
        requests++
        if (e.outcome !== 'ok' && e.outcome !== 'aborted') failed++
      }
    }
    return { steps, requests, failed }
  }, [snap.events])

  // Focus the first field on open; restore focus to the trigger on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    firstRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!sending) onClose()
      return
    }
    if (e.key !== 'Tab' || !rootRef.current) return
    const items = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const send = async () => {
    if (!title.trim() || sending) return
    setSending(true)
    setError(null)
    const parts: { part: string; blob: Blob; name: string }[] = []
    const meta: ReportPayload['images'] = []
    let screenshotError = screenshot.error
    if (screenshot.dataUrl) {
      try {
        const blob = annotatorRef.current ? await annotatorRef.current.toBlob() : null
        if (blob) {
          parts.push({ part: 'image_0', blob, name: 'screenshot.jpg' })
          meta.push({ part: 'image_0', kind: 'screenshot', name: 'screenshot.jpg' })
        }
      } catch (err) {
        screenshotError = err instanceof Error ? err.message : String(err)
      }
    }
    for (const img of images) {
      const part = `image_${parts.length}`
      parts.push({ part, blob: img.blob, name: img.name })
      meta.push({ part, kind: 'attachment', name: img.name })
    }
    const payload: ReportPayload = {
      v: PAYLOAD_VERSION,
      project,
      createdAt: Date.now(),
      title: title.trim(),
      ...(expected.trim() ? { expected: expected.trim() } : {}),
      severity,
      verdict: snap.verdict,
      context,
      env: buildEnv(),
      events: snap.events,
      curls: snap.curls,
      images: meta,
      ...(screenshotError ? { screenshotError } : {}),
    }
    try {
      const res = await submit(payload, parts)
      onToast(fmt(labels.sentAs, { ref: res.ref }))
      onClose()
    } catch (err) {
      if (errorCode(err) === 'queued') {
        onToast(labels.queued)
        onClose()
        return
      }
      setError(labels.rejected)
      setSending(false)
    }
  }

  const contextEntries = Object.entries(context).filter(([, v]) => v != null && v !== '')
  const sev: [Severity, string][] = [
    ['blocker', labels.severityBlocker],
    ['annoying', labels.severityAnnoying],
    ['minor', labels.severityMinor],
  ]

  return (
    <div
      className="dalil-root dalil-backdrop"
      data-dalil-ignore=""
      dir={dir}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !sending) onClose()
      }}
    >
      <div
        ref={rootRef}
        className="dalil-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        dir={dir}
        onKeyDown={onKeyDown}
      >
        <div className="dalil-head">
          <h2 id={`${ids}-title`}>{labels.dialogTitle}</h2>
          <button type="button" className="dalil-x" aria-label={labels.close} onClick={onClose} disabled={sending}>
            ×
          </button>
        </div>

        {screenshot.dataUrl ? (
          <Annotator ref={annotatorRef} src={screenshot.dataUrl} labels={labels} />
        ) : (
          <p className="dalil-notice" role="note">
            {labels.screenshotFailed}
          </p>
        )}

        <div className="dalil-field">
          <label className="dalil-label" htmlFor={`${ids}-what`}>
            {labels.whatWentWrong}
          </label>
          <textarea
            id={`${ids}-what`}
            ref={firstRef}
            className="dalil-textarea"
            required
            aria-required="true"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="dalil-field">
          <label className="dalil-label" htmlFor={`${ids}-exp`}>
            {labels.whatExpected}
          </label>
          <textarea
            id={`${ids}-exp`}
            className="dalil-textarea"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </div>

        <fieldset className="dalil-sev">
          <legend>{labels.severity}</legend>
          {sev.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name={`${ids}-sev`}
                value={value}
                checked={severity === value}
                onChange={() => setSeverity(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <ImagePicker images={images} onChange={setImages} labels={labels} />

        <details className="dalil-summary">
          <summary>{labels.whatWillBeSent}</summary>
          <ul>
            <li>
              {labels.likely}: {snap.verdict.headline}
            </li>
            <li>{fmt(labels.steps, { n: counts.steps })}</li>
            <li>{fmt(labels.requests, { n: counts.requests, m: counts.failed })}</li>
            <li>
              {labels.contextFields}:{' '}
              {contextEntries.length
                ? contextEntries.map(([k, v]) => `${k}: ${v}`).join(', ')
                : labels.noContext}
            </li>
          </ul>
        </details>

        {error && (
          <p className="dalil-error" role="alert">
            {error}
          </p>
        )}

        <div className="dalil-actions">
          <button type="button" className="dalil-btn" onClick={onClose} disabled={sending}>
            {labels.cancel}
          </button>
          <button
            type="button"
            className="dalil-btn dalil-primary"
            onClick={send}
            disabled={!title.trim() || sending}
          >
            {sending ? labels.sending : labels.send}
          </button>
        </div>
      </div>
    </div>
  )
}
