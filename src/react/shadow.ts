import type { DalilTheme } from './styles'

export interface ShadowHost {
  host: HTMLElement
  shadow: ShadowRoot
  mount: HTMLElement
  /** Mirror theme/accent onto the host element as CSS variables. */
  setAppearance: (a: { theme?: DalilTheme; accent?: string; accentForeground?: string }) => void
  destroy: () => void
}

/** Creates `<dalil-root data-dalil-ignore>` on document.body with an open shadow root. */
export function createShadowHost(): ShadowHost {
  const host = document.createElement('dalil-root')
  host.setAttribute('data-dalil-ignore', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const mount = document.createElement('div')
  shadow.appendChild(mount)
  document.body.appendChild(host)
  return {
    host,
    shadow,
    mount,
    setAppearance: (a) => {
      if (a.theme === 'light' || a.theme === 'dark') host.setAttribute('data-theme', a.theme)
      else host.removeAttribute('data-theme')
      for (const [k, v] of [['--dalil-accent', a.accent], ['--dalil-accent-fg', a.accentForeground]] as const) {
        if (v) host.style.setProperty(k, v)
        else host.style.removeProperty(k)
      }
    },
    destroy: () => host.remove(),
  }
}
