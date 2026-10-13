"use client"
// `dalil/next`: <DalilClient config={...}/> for App Router layouts and Pages Router _app.
import { useEffect, useRef } from 'react'
import { destroy, init, update, type DalilWebConfig } from '../web'

export type { DalilWebConfig }

export function DalilClient({ config }: { config: DalilWebConfig }): null {
  const latest = useRef(config)
  latest.current = config
  useEffect(() => {
    init({ ...latest.current, getContext: () => latest.current.getContext?.() ?? {} })
    return () => destroy()
  }, [])
  useEffect(() => {
    update({ enabled: config.enabled, getContext: () => latest.current.getContext?.() ?? {} })
  }, [config.enabled, config.getContext])
  return null
}
