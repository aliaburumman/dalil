import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { open as coreOpen } from '../core'
import { DalilWidget, matchesShortcut, preload, type DalilWidgetProps } from './DalilWidget'
import { createShadowHost } from './shadow'

export { matchesShortcut, preload }

export interface DalilProviderProps extends Omit<DalilWidgetProps, 'styleRoot'> {
  /** Render inside an open shadow root so host CSS cannot affect the widget. Default false (light DOM). */
  shadow?: boolean
  children?: ReactNode
}

export function DalilProvider({ children, shadow = false, ...props }: DalilProviderProps) {
  const [host, setHost] = useState<ReturnType<typeof createShadowHost> | null>(null)
  useEffect(() => {
    if (!shadow) return
    const h = createShadowHost()
    setHost(h)
    return () => {
      h.destroy()
      setHost(null)
    }
  }, [shadow])
  if (typeof document === 'undefined') return <>{children}</>
  if (shadow) {
    return (
      <>
        {children}
        {host && createPortal(<DalilWidget {...props} styleRoot={host.shadow} />, host.mount)}
      </>
    )
  }
  return (
    <>
      {children}
      {createPortal(<DalilWidget {...props} />, document.body)}
    </>
  )
}

/** Host-side trigger, usable anywhere (with or without the provider in the tree). */
export function useDalil(): { open: () => void } {
  return useMemo(() => ({ open: () => coreOpen() }), [])
}
