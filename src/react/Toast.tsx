import { useEffect } from 'react'

interface Props {
  message: string
  dir: 'ltr' | 'rtl'
  onDone: () => void
}

/** Self-contained toast; hides after 5 s. */
export function Toast({ message, dir, onDone }: Props) {
  useEffect(() => {
    const t = setTimeout(onDone, 5000)
    return () => clearTimeout(t)
  }, [message, onDone])
  return (
    <div className="dalil-root" data-dalil-ignore="" dir={dir}>
      <div className="dalil-toast" role="status" aria-live="polite">
        {message}
      </div>
    </div>
  )
}
