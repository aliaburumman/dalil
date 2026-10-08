import type { Labels } from './labels'
import { rootAttrs, type Appearance } from './styles'

interface Props extends Appearance {
  labels: Labels
  dir: 'ltr' | 'rtl'
  position: 'bottom-end' | 'bottom-start'
  onOpen: () => void
  onPreload: () => void
}

export function Button({ labels, dir, position, onOpen, onPreload, ...appearance }: Props) {
  return (
    <div className="dalil-root" data-dalil-ignore="" dir={dir} {...rootAttrs(appearance)}>
      <button
        type="button"
        className="dalil-fab"
        data-pos={position}
        aria-label={labels.button}
        title={labels.button}
        onMouseEnter={onPreload}
        onFocus={onPreload}
        onTouchStart={onPreload}
        onClick={onOpen}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M22 13h-4M3 21c0-2.1 1.7-3.8 3.8-3.8M21 21c0-2.1-1.7-3.8-3.8-3.8M3 5c0 2.1 1.7 3.8 3.8 3.8M21 5c0 2.1-1.7 3.8-3.8 3.8" />
        </svg>
        <span>{labels.button}</span>
      </button>
    </div>
  )
}
