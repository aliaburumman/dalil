import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { init, onOpen, open as coreOpen, snapshot, type DalilConfig } from '../core'
import { Button } from './Button'
import type { DialogProps, DialogSnapshot } from './Dialog'
import { defaultLabels, type Labels } from './labels'
import { ensureStyles, type DalilTheme } from './styles'
import type { ReplayHandle } from './replay'
import { Toast } from './Toast'

export interface DalilProviderProps extends DalilConfig {
  /** Host decides who sees the widget. When false nothing renders and open() is ignored. */
  enabled: boolean
  labels?: Partial<Labels>
  dir?: 'ltr' | 'rtl'
  position?: 'bottom-end' | 'bottom-start'
  /** e.g. "mod+shift+b" (mod = Ctrl or ⌘). `false` disables it. Default "mod+shift+b". */
  shortcut?: string | false
  hideButton?: boolean
  /** 'system' (default) follows prefers-color-scheme; 'light'/'dark' force it (use your app's own theme). */
  theme?: DalilTheme
  /** Brand colour for the button and primary actions: any CSS colour, e.g. 'var(--primary)'. Pass with accentForeground. */
  accent?: string
  /** Text colour on the accent. Defaults to white; pass it whenever you pass accent. */
  accentForeground?: string
  /** Record the last 1-2 minutes of the screen (inputs masked) for the report. Default true. */
  replay?: boolean
  children?: ReactNode
}

type Chunks = [typeof import('./Dialog'), typeof import('./screenshot')]
let chunks: Promise<Chunks> | null = null

/** Loads the dialog + screenshot chunks once; safe to call repeatedly. */
export function preload(): Promise<Chunks> {
  if (!chunks) {
    chunks = Promise.all([import('./Dialog'), import('./screenshot')])
    chunks.catch(() => {
      chunks = null
    })
  }
  return chunks
}

export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+').map((p) => p.trim())
  const key = parts[parts.length - 1]
  const has = (m: string) => parts.includes(m)
  const mod = has('mod')
  if (mod ? !(e.ctrlKey || e.metaKey) : e.ctrlKey !== has('ctrl') || e.metaKey !== has('meta')) return false
  if (e.shiftKey !== has('shift') || e.altKey !== has('alt')) return false
  return (e.key || '').toLowerCase() === key || e.code.toLowerCase() === `key${key}`
}

type State =
  | { phase: 'idle' }
  | { phase: 'capturing' }
  | {
      phase: 'open'
      Dialog: (p: DialogProps) => ReactNode
      snap: DialogSnapshot
      screenshot: { dataUrl?: string; error?: string }
      autoSnaps: ReturnType<typeof import('./autosnap').getAutoSnaps>
      replay: ReplayHandle | null
    }

export function DalilProvider(props: DalilProviderProps) {
  const {
    enabled,
    labels: labelOverrides,
    dir = 'ltr',
    position = 'bottom-end',
    shortcut = 'mod+shift+b',
    hideButton = false,
    theme = 'system',
    accent,
    accentForeground,
    replay = true,
    children,
    ...config
  } = props

  const appearance = { theme, accent, accentForeground }
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [toast, setToast] = useState<string | null>(null)
  const phaseRef = useRef(state.phase)
  phaseRef.current = state.phase
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const getContextRef = useRef(config.getContext)
  getContextRef.current = config.getContext

  const labels = useMemo<Labels>(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides])
  const getContext = useCallback(() => getContextRef.current?.() ?? {}, [])

  // init is idempotent; call once with a getContext that always reads the latest prop.
  const inited = useRef(false)
  useEffect(() => {
    if (inited.current) return
    inited.current = true
    init({ ...config, getContext })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    ensureStyles()
  }, [])

  // Failure-moment screenshots: lazy, only while enabled.
  const autoModRef = useRef<typeof import('./autosnap') | null>(null)
  useEffect(() => {
    if (!enabled) return
    let stop: (() => void) | undefined
    let cancelled = false
    import('./autosnap')
      .then((m) => {
        if (cancelled) return
        autoModRef.current = m
        stop = m.startAutoSnap()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      stop?.()
    }
  }, [enabled])

  // Session replay: lazy chunk, loaded when the browser is idle, only while enabled.
  const replayRef = useRef<ReplayHandle | null>(null)
  useEffect(() => {
    if (!enabled || !replay) return
    let cancelled = false
    const start = () => {
      import('./replay')
        .then((m) => {
          if (cancelled) return
          replayRef.current = m.startReplay()
        })
        .catch(() => {})
    }
    const idle = typeof window.requestIdleCallback === 'function'
    const handle = idle ? window.requestIdleCallback(start, { timeout: 3000 }) : window.setTimeout(start, 1)
    return () => {
      cancelled = true
      if (idle) window.cancelIdleCallback(handle)
      else window.clearTimeout(handle)
      replayRef.current?.stop()
      replayRef.current = null
    }
  }, [enabled, replay])

  const openWidget = useCallback(async () => {
    if (!enabledRef.current || phaseRef.current !== 'idle') return
    phaseRef.current = 'capturing'
    setState({ phase: 'capturing' })
    const openedSnap = snapshot()
    try {
      const [dialogMod, shotMod] = await preload()
      let shot: { dataUrl?: string; error?: string }
      try {
        shot = { dataUrl: await shotMod.captureScreenshot() }
      } catch (err) {
        shot = { error: err instanceof Error ? err.message : String(err) || 'Screenshot failed' }
      }
      setState({
        phase: 'open',
        Dialog: dialogMod.Dialog,
        snap: openedSnap,
        screenshot: shot,
        autoSnaps: autoModRef.current?.getAutoSnaps() ?? [],
        replay: replayRef.current,
      })
    } catch {
      // Chunk failed to load (offline / deploy race); nothing to show.
      setState({ phase: 'idle' })
    }
  }, [])

  useEffect(() => {
    const off = onOpen(() => {
      void openWidget()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [openWidget])

  useEffect(() => {
    if (!enabled || !shortcut) return
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, shortcut)) return
      e.preventDefault()
      void preload()
      void openWidget()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, shortcut, openWidget])

  const close = useCallback(() => setState({ phase: 'idle' }), [])
  const clearToast = useCallback(() => setToast(null), [])

  const widget =
    typeof document === 'undefined' ? null : (
      <>
        {enabled && !hideButton && state.phase === 'idle' && (
          <Button
            labels={labels}
            dir={dir}
            {...appearance}
            position={position}
            onOpen={() => void openWidget()}
            onPreload={() => void preload()}
          />
        )}
        {enabled && state.phase === 'open' && (
          <state.Dialog
            project={config.project}
            labels={labels}
            dir={dir}
            {...appearance}
            getContext={getContext}
            snap={state.snap}
            screenshot={state.screenshot}
            autoSnaps={state.autoSnaps}
            replay={state.replay}
            onClose={close}
            onToast={setToast}
          />
        )}
        {toast && <Toast message={toast} dir={dir} {...appearance} onDone={clearToast} />}
      </>
    )

  return (
    <>
      {children}
      {widget && createPortal(widget, document.body)}
    </>
  )
}

/** Host-side trigger, usable anywhere (with or without the provider in the tree). */
export function useDalil(): { open: () => void } {
  return useMemo(() => ({ open: () => coreOpen() }), [])
}
