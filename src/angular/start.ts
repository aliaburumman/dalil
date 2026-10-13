// Pure start-timing helper for dalil/angular: runs `start` once, when the first signal fires.
// A signal subscribes and returns an optional cleanup. Tested without Angular.
export type StartSignal = (fire: () => void) => void | (() => void)

export function startOnFirst(start: () => void, signals: StartSignal[]): () => void {
  let done = false
  const cleanups: Array<() => void> = []
  const cleanup = () => {
    for (const c of cleanups.splice(0)) c()
  }
  const fire = () => {
    if (done) return
    done = true
    cleanup()
    start()
  }
  for (const s of signals) {
    if (done) break
    const c = s(fire)
    if (c) cleanups.push(c)
  }
  if (done) cleanup()
  return () => {
    done = true
    cleanup()
  }
}

/** window `load` (immediately when already loaded) plus a timeout, for apps that never become stable. */
export function loadOrTimeout(timeoutMs = 5000): StartSignal {
  return (fire) => {
    if (typeof window === 'undefined') return
    if (document.readyState === 'complete') {
      const t = setTimeout(fire, timeoutMs)
      return () => clearTimeout(t)
    }
    let t: ReturnType<typeof setTimeout> | undefined
    const onLoad = () => {
      t = setTimeout(fire, timeoutMs)
    }
    window.addEventListener('load', onLoad, { once: true })
    return () => {
      window.removeEventListener('load', onLoad)
      if (t) clearTimeout(t)
    }
  }
}

/** The config may be a factory (called inside the injection context so it can use inject()). */
export function resolveConfig<T>(config: T | (() => T)): T {
  return typeof config === 'function' ? (config as () => T)() : config
}
