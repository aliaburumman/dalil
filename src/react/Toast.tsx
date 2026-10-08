import { useEffect } from 'react'
import { rootAttrs, type Appearance } from './styles'

interface Props extends Appearance {
  message: string
  dir: 'ltr' | 'rtl'
  onDone: () => void
}

/** Self-contained toast; hides after 5 s. */
export function Toast({ message, dir, onDone, ...appearance }: Props) {
  useEffect(() => {
    const t = setTimeout(onDone, 5000)
    return () => clearTimeout(t)
  }, [message, onDone])
  return (
    <div className="dalil-root" data-dalil-ignore="" dir={dir} {...rootAttrs(appearance)}>
      <div className="dalil-toast" role="status" aria-live="polite">
        {message}
      </div>
    </div>
  )
}
