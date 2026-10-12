// Shown inside the dialog when filing the Bug failed. The report is still in memory, so the tester
// can retry, fix the token, download the evidence zip or copy the report. Nothing is lost.
import { useEffect, useId, useRef, useState } from 'react'
import type { Share } from '../core'
import { downloadBlob } from '../core/zip'
import { copyShare } from './clipboard'
import { errorText } from './ConnectAdo'
import { fmt, pick, type Labels } from './labels'
import { usePanel } from './panel'
import { rootAttrs, type Appearance } from './styles'

export interface AdoErrorPanelProps extends Appearance {
  code: string
  org: string
  project: string
  share: Share
  labels: Labels
  dir: 'ltr' | 'rtl'
  /** builds the evidence zip (called once on mount so the click can download synchronously) */
  evidence: () => Promise<Blob>
  onUpdateToken: () => void
  onRetry: () => void
  onClose: () => void
}

export function AdoErrorPanel({ code, org, project, share, labels, dir, evidence, onUpdateToken, onRetry, onClose, theme, accent, accentForeground }: AdoErrorPanelProps) {
  const ids = useId()
  const { rootRef, firstRef, onKeyDown } = usePanel(onClose)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed' | 'blocked'>('idle')
  const zip = useRef<Blob | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let live = true
    evidence().then((b) => {
      if (live) zip.current = b
    }, () => {})
    return () => {
      live = false
      clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const v = { org, project }
  const tokenProblem = code === 'auth' || code === 'forbidden'
  const message =
    code === 'auth'
      ? pick(labels, 'adoTokenExpired')
      : code === 'forbidden'
        ? fmt(pick(labels, 'adoNoAccess'), v)
        : code === 'rejected'
          ? pick(labels, 'adoRejected')
          : errorText(labels, code, org, project)

  const download = () => {
    const container = () => {
      const node = rootRef.current?.getRootNode?.()
      return node && 'host' in node ? (node as ShadowRoot) : document.body
    }
    const done = (ok: boolean) => setStatus(ok ? 'idle' : 'blocked')
    if (zip.current) return done(downloadBlob(zip.current, 'dalil-evidence.zip', container()))
    evidence().then((b) => {
      zip.current = b
      done(downloadBlob(b, 'dalil-evidence.zip', container()))
    }, () => done(false))
  }

  const copy = () =>
    copyShare(share, (ok) => {
      setStatus(ok ? 'copied' : 'failed')
      clearTimeout(timer.current)
      if (ok) timer.current = setTimeout(() => setStatus('idle'), 2000)
    })

  return (
    <div className="dalil-root dalil-backdrop" data-dalil-ignore="" dir={dir} {...rootAttrs({ theme, accent, accentForeground })}>
      <div ref={rootRef} className="dalil-dialog dalil-sent" role="alertdialog" aria-modal="true" aria-labelledby={`${ids}-title`} dir={dir} onKeyDown={onKeyDown}>
        <div className="dalil-head">
          <h2 id={`${ids}-title`}>{message}</h2>
        </div>
        <p className="dalil-status" role="status" aria-live="polite">
          {status === 'copied' ? pick(labels, 'copied') : status === 'failed' ? pick(labels, 'copyFailed') : status === 'blocked' ? pick(labels, 'adoDownloadFailed') : ''}
        </p>
        <div className="dalil-actions" style={{ flexWrap: 'wrap' }}>
          {tokenProblem ? (
            <button ref={firstRef as React.RefObject<HTMLButtonElement>} type="button" className="dalil-btn dalil-primary" onClick={onUpdateToken}>
              {pick(labels, 'adoUpdateToken')}
            </button>
          ) : (
            code !== 'rejected' && (
              <button ref={firstRef as React.RefObject<HTMLButtonElement>} type="button" className="dalil-btn dalil-primary" onClick={onRetry}>
                {pick(labels, 'adoTryAgain')}
              </button>
            )
          )}
          <button type="button" className="dalil-btn" onClick={download}>
            {pick(labels, 'adoDownload')}
          </button>
          <button type="button" className="dalil-btn" onClick={copy}>
            {pick(labels, 'copyReport')}
          </button>
          <button ref={code === 'rejected' ? (firstRef as React.RefObject<HTMLButtonElement>) : undefined} type="button" className="dalil-btn" onClick={onClose}>
            {pick(labels, 'done')}
          </button>
        </div>
      </div>
    </div>
  )
}
