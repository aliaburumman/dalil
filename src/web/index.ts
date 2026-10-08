// Framework-free entry: `dalil/web` (ESM) and `dalil.global.js` (window.Dalil).
// Mounts the same widget as dalil/react inside an open shadow root. In the web builds
// react/react-dom are aliased to preact/compat.
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { init as coreInit, log as coreLog, open as coreOpen, type DalilConfig } from '../core'
import { DalilWidget, type DalilWidgetProps } from '../react/DalilWidget'
import { createShadowHost, type ShadowHost } from '../react/shadow'

export type DalilWebConfig = Omit<DalilWidgetProps, 'styleRoot' | 'enabled'> & { enabled?: boolean }

let current: DalilWebConfig | null = null
let host: ShadowHost | null = null
let root: Root | null = null
let mountPending = false
let onReady: (() => void) | null = null

function render(): void {
  if (!current || !host || !root) return
  const { enabled = true, ...rest } = current
  host.setAppearance({ theme: rest.theme, accent: rest.accent, accentForeground: rest.accentForeground })
  root.render(createElement(DalilWidget, { ...rest, enabled, styleRoot: host.shadow }))
}

function mount(): void {
  mountPending = false
  if (!current || host) return
  host = createShadowHost()
  root = createRoot(host.mount)
  render()
}

/** Starts the recorder now and mounts the UI (after DOMContentLoaded if needed). Idempotent. */
export function init(config: DalilWebConfig): void {
  if (current) {
    update(config)
    return
  }
  current = { ...config }
  coreInit({ ...(config as DalilConfig), getContext: () => current?.getContext?.() ?? {} })
  if (typeof document === 'undefined') return
  if (document.readyState === 'loading' || !document.body) {
    mountPending = true
    onReady = () => mount()
    document.addEventListener('DOMContentLoaded', onReady, { once: true })
  } else mount()
}

/** Merge new props at runtime (login/logout, language switch, theme). */
export function update(partial: Partial<DalilWebConfig>): void {
  if (!current) return
  current = { ...current, ...partial }
  render()
}

export function open(): void {
  coreOpen()
}

export const log: typeof coreLog = (...args) => coreLog(...args)

/** Unmounts the UI (stopping replay and auto-snapshots) and removes the host element. */
export function destroy(): void {
  if (onReady) document.removeEventListener('DOMContentLoaded', onReady)
  onReady = null
  mountPending = false
  root?.unmount()
  host?.destroy()
  root = host = current = null
}
