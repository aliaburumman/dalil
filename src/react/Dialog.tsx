// Lazy chunk: the report dialog. Rendered only after the screenshot attempt finished.
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DalilSubmitError,
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
import type { AutoSnap } from './autosnap'
import type { ReplayHandle } from './replay'
import { fitBody, type SizedPart } from './assemble'
import { dataUrlToBlob } from './images'
import { Annotator, type AnnotatorHandle } from './Annotator'
import { ImagePicker, type PickedImage } from './ImagePicker'
import { defaultLabels, fmt, type Labels } from './labels'
import { rootAttrs, type Appearance } from './styles'

export interface DialogSnapshot {
  events: DalilEvent[]
  verdict: Verdict
  curls: Record<string, string>
}

export interface DialogProps extends Appearance {
  project: string
  labels: Labels
  dir: 'ltr' | 'rtl'
  getContext?: () => ReportContext
  snap: DialogSnapshot
  screenshot: { dataUrl?: string; error?: string }
  /** Screens captured at failure moments, oldest first (v0.2). */
  autoSnaps?: AutoSnap[]
  /** The running replay recorder, when replay is enabled. */
  replay?: ReplayHandle | null
  onClose: () => void
  onToast: (message: string) => void
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const sec = total % 60
  return m ? `${m}m ${sec}s` : `${sec}s`
}

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
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

const FOCUSABLE =
  'button:not([disabled]),[href],input:not([disabled]),select,textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary'

/** Active element within the node's own root (document or shadow root). */
function activeIn(node: Element | null): HTMLElement | null {
  const root = node?.getRootNode?.() as Document | ShadowRoot | undefined
  return ((root && 'activeElement' in root ? root.activeElement : document.activeElement) as HTMLElement | null) ?? null
}

export function Dialog({ project, labels, dir, getContext, snap, screenshot, autoSnaps: initialAutos, replay, onClose, onToast, theme, accent, accentForeground }: DialogProps) {
  const ids = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLTextAreaElement>(null)
  const annotatorRef = useRef<AnnotatorHandle>(null)
  const [title, setTitle] = useState('')
  const [expected, setExpected] = useState('')
  const [severity, setSeverity] = useState<Severity>('annoying')
  const [images, setImages] = useState<PickedImage[]>([])
  const [sending, setSending] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [autos, setAutos] = useState<AutoSnap[]>(initialAutos ?? [])
  const [includeReplay, setIncludeReplay] = useState(true)
  const replayInfo = useMemo(() => replay?.info() ?? null, [replay])
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

  // Layout effects (not passive) so focus and Escape work the moment the dialog is in the DOM, before any paint.
  // Focus the first field on every open (retrying once next frame in case the host still holds focus);
  // restore focus to the opener on close.
  useLayoutEffect(() => {
    const root = rootRef.current?.getRootNode?.() as Document | ShadowRoot | undefined
    const doc = rootRef.current?.ownerDocument ?? document
    // The opener lives in the page's document even when the dialog is inside a shadow root.
    const own = activeIn(rootRef.current)
    const prev = own && own !== doc.body ? own : root && 'host' in root ? (doc.activeElement as HTMLElement | null) : own
    const inside = () => {
      const a = activeIn(rootRef.current)
      return !!a && !!rootRef.current?.contains(a)
    }
    firstRef.current?.focus()
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => { if (!inside()) firstRef.current?.focus() }) : 0
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      prev?.focus?.()
    }
  }, [])

  // Escape closes while the dialog is open, wherever focus is (listener lives on the owner document).
  const closeRef = useRef({ sending, onClose })
  closeRef.current = { sending, onClose }
  useLayoutEffect(() => {
    const doc = rootRef.current?.ownerDocument ?? document
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
      if (closeRef.current.sending) return
      closeRef.current.onClose()
    }
    doc.addEventListener('keydown', onDocKey, true)
    return () => doc.removeEventListener('keydown', onDocKey, true)
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
    const active = activeIn(rootRef.current)
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
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
    const images0 = parts.map((p): SizedPart => p)
    let replayError: string | undefined
    let replayPart: (SizedPart & { meta: NonNullable<ReportPayload['replay']> }) | undefined
    if (replay) {
      if (!includeReplay) replayError = 'excluded by tester'
      else if (replay.status().state === 'unsupported') replayError = 'unsupported'
      else {
        setPreparing(true)
        try {
          const prepared = await replay.prepare()
          if ('blob' in prepared) replayPart = { part: 'replay', name: 'replay.json.gz', blob: prepared.blob, meta: prepared.meta }
          else replayError = prepared.error
        } catch {
          replayError = 'Replay could not be prepared'
        }
        setPreparing(false)
      }
    }
    const autoParts = autos.map((a, i) => ({ part: `auto_${i}`, name: `auto_${i}.jpg`, blob: dataUrlToBlob(a.dataUrl), snap: a }))
    const draft = (autoKept: typeof autoParts, rp: typeof replayPart, rErr?: string): ReportPayload => ({
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
      ...(autoKept.length
        ? {
            autoSnaps: autoKept.map((a, i) => ({
              part: `auto_${i}`,
              t: a.snap.t,
              reason: a.snap.reason,
              label: a.snap.label,
              ...(a.snap.eventId ? { eventId: a.snap.eventId } : {}),
            })),
          }
        : {}),
      ...(rp ? { replay: rp.meta } : {}),
      ...(rErr ? { replayError: rErr } : {}),
    })
    // Fit the whole body under the collector limit: replay goes first, then the oldest auto-snapshot.
    const fit = fitBody({
      reportBytes: JSON.stringify(draft(autoParts, replayPart)).length,
      images: images0,
      autos: autoParts,
      replay: replayPart,
    })
    const kept = fit.autos.map((a, i) => ({ ...a, part: `auto_${i}`, name: `auto_${i}.jpg` }))
    const finalReplay = fit.replay as typeof replayPart
    if (fit.replayDropped) replayError = 'dropped to fit the size limit'
    const payload = draft(kept, finalReplay, replayError)
    const uploads = [
      ...parts,
      ...kept.map((a) => ({ part: a.part, name: a.name, blob: a.blob })),
      ...(finalReplay ? [{ part: 'replay', name: finalReplay.name, blob: finalReplay.blob }] : []),
    ]
    try {
      const res = await submit(payload, uploads)
      onToast(fmt(labels.sentAs, { ref: res.ref }))
      onClose()
    } catch (err) {
      if (err instanceof DalilSubmitError && err.code === 'queued') {
        onToast(labels.queued)
        onClose()
        return
      }
      if (err instanceof DalilSubmitError && err.code === 'unreachable') {
        onToast(labels.unreachable ?? defaultLabels.unreachable!)
        onClose()
        return
      }
      const code = err instanceof DalilSubmitError ? err.code : null
      setError(
        code === 'save_failed'
          ? labels.saveFailed
          : code === 'build_failed'
            ? (labels.buildFailed ?? defaultLabels.buildFailed!)
            : labels.rejected,
      )
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
      {...rootAttrs({ theme, accent, accentForeground })}
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

        {autos.length > 0 && (
          <section className="dalil-field" aria-label={labels.autoCaptured}>
            <span className="dalil-label">{labels.autoCaptured}</span>
            <div className="dalil-autos">
              {autos.map((a) => (
                <figure className="dalil-auto" key={a.t + a.label}>
                  <img src={a.dataUrl} alt={a.label} />
                  <figcaption>
                    {formatTime(a.t)} · {a.label}
                  </figcaption>
                  <button
                    type="button"
                    aria-label={labels.removeAutoCaptured ?? 'Remove this capture'}
                    disabled={sending}
                    onClick={() => setAutos((cur) => cur.filter((x) => x !== a))}
                  >
                    ×
                  </button>
                </figure>
              ))}
            </div>
          </section>
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
            {snap.verdict.userSaw && <li>{labels.userSaw ?? 'User saw'}: "{snap.verdict.userSaw}"</li>}
            <li>{fmt(counts.steps === 1 ? (labels.stepsOne ?? labels.steps) : labels.steps, { n: counts.steps })}</li>
            <li>{fmt(counts.requests === 1 ? (labels.requestsOne ?? labels.requests) : labels.requests, { n: counts.requests, m: counts.failed })}</li>
            {replayInfo && (
              <li className="dalil-rec">
                <span>
                  {fmt(labels.screenRecording ?? 'Screen recording: last {duration} (inputs hidden)', {
                    duration: formatDuration(replayInfo.durationMs),
                  })}
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={includeReplay}
                    disabled={sending}
                    onChange={(e) => setIncludeReplay(e.target.checked)}
                  />{' '}
                  {labels.includeRecording ?? 'Include the screen recording'}
                </label>
              </li>
            )}
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
            {preparing ? (labels.preparingRecording ?? 'Preparing recording…') : sending ? labels.sending : labels.send}
          </button>
        </div>
      </div>
    </div>
  )
}
