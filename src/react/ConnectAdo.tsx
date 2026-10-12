// Lazy chunk: asks the tester for their own Azure DevOps token (validated, then stored in this browser).
import { useId, useState } from 'react'
import { AdoError } from '../../shared/adoClient'
import { forgetToken, saveToken } from '../core/adoToken'
import { fmt, pick, type Labels } from './labels'
import { usePanel } from './panel'
import { rootAttrs, type Appearance } from './styles'

export interface ConnectAdoProps extends Appearance {
  org: string
  project: string
  labels: Labels
  dir: 'ltr' | 'rtl'
  /** a token is already stored (shows Forget token) */
  hasToken?: boolean
  /** shown above the field, e.g. "token expired" */
  notice?: string
  /** `persisted` is false when browser storage is unavailable (the token lives for this page session only) */
  onSaved: (pat: string, persisted: boolean) => void
  onForgotten?: () => void
  onCancel: () => void
}

export function errorText(labels: Labels, code: string, org: string, project: string): string {
  const v = { org, project }
  if (code === 'auth') return fmt(pick(labels, 'adoErrAuth'), v)
  if (code === 'forbidden') return fmt(pick(labels, 'adoErrForbidden'), v)
  if (code === 'notfound') return fmt(pick(labels, 'adoErrNotFound'), v)
  return fmt(pick(labels, 'adoErrUnreachable'), v)
}

export function ConnectAdo({ org, project, labels, dir, hasToken, notice, onSaved, onForgotten, onCancel, theme, accent, accentForeground }: ConnectAdoProps) {
  const ids = useId()
  const { rootRef, firstRef, onKeyDown } = usePanel(onCancel)
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const v = { org, project }

  const save = async () => {
    const token = pat.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await saveToken(org, project, token)
      setBusy(false)
      onSaved(token, res.persisted)
    } catch (err) {
      setError(errorText(labels, err instanceof AdoError ? err.code : 'unavailable', org, project))
      setBusy(false)
    }
  }

  return (
    <div
      className="dalil-root dalil-backdrop"
      data-dalil-ignore=""
      dir={dir}
      {...rootAttrs({ theme, accent, accentForeground })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
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
          <h2 id={`${ids}-title`}>{pick(labels, 'adoConnectTitle')}</h2>
          <button type="button" className="dalil-x" aria-label={labels.close} onClick={onCancel} disabled={busy}>
            ×
          </button>
        </div>
        {notice && <p className="dalil-notice" role="note">{notice}</p>}
        <p className="dalil-status">{fmt(pick(labels, 'adoConnectIntro'), v)}</p>
        <form
          className="dalil-field"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="dalil-label" htmlFor={`${ids}-pat`}>
            {pick(labels, 'adoTokenLabel')}
          </label>
          <input
            id={`${ids}-pat`}
            ref={firstRef as React.RefObject<HTMLInputElement>}
            className="dalil-textarea"
            style={{ minHeight: 0 }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
          <a href={`https://dev.azure.com/${encodeURIComponent(org)}/_usersSettings/tokens`} target="_blank" rel="noopener noreferrer">
            {pick(labels, 'adoCreateToken')}
          </a>
          {error && (
            <p className="dalil-error" role="alert">
              {error}
            </p>
          )}
          <div className="dalil-actions">
            {hasToken && (
              <button
                type="button"
                className="dalil-btn"
                disabled={busy}
                onClick={() => {
                  void forgetToken(org).then(() => onForgotten?.())
                }}
              >
                {pick(labels, 'adoForget')}
              </button>
            )}
            <button type="button" className="dalil-btn" onClick={onCancel} disabled={busy}>
              {labels.cancel}
            </button>
            <button type="submit" className="dalil-btn dalil-primary" disabled={!pat.trim() || busy}>
              {busy ? pick(labels, 'adoValidating') : pick(labels, 'adoValidate')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
