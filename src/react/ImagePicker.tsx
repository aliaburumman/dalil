import { useEffect, useId, useRef, useState } from 'react'
import { toJpegUnder2MB } from './images'
import type { Labels } from './labels'

export interface PickedImage {
  id: string
  name: string
  blob: Blob
  url: string
}

export const MAX_IMAGES = 5

interface Props {
  images: PickedImage[]
  onChange: (next: PickedImage[]) => void
  labels: Labels
}

let seq = 0

export function ImagePicker({ images, onChange, labels }: Props) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const latest = useRef(images)
  latest.current = images

  // Revoke thumbnail URLs on unmount.
  useEffect(() => () => latest.current.forEach((i) => URL.revokeObjectURL(i.url)), [])

  const add = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const room = MAX_IMAGES - latest.current.length
    setNote(imgs.length > room ? labels.imageLimit : null)
    const added: PickedImage[] = []
    for (const f of imgs.slice(0, Math.max(0, room))) {
      try {
        const blob = await toJpegUnder2MB(f)
        const base = (f.name || 'image').replace(/\.[^.]+$/, '')
        added.push({ id: `img${++seq}`, name: `${base}.jpg`, blob, url: URL.createObjectURL(blob) })
      } catch {
        setNote(labels.imageFailed)
      }
    }
    if (added.length) onChange([...latest.current, ...added].slice(0, MAX_IMAGES))
  }

  // Paste anywhere while the dialog is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.some((f) => f.type.startsWith('image/'))) {
        e.preventDefault()
        void add(files)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  const remove = (img: PickedImage) => {
    URL.revokeObjectURL(img.url)
    onChange(images.filter((i) => i.id !== img.id))
    setNote(null)
  }

  return (
    <div
      className="dalil-drop"
      data-over={over}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void add(Array.from(e.dataTransfer.files))
      }}
    >
      <span className="dalil-label">{labels.images}</span>
      <span style={{ color: 'var(--dalil-muted)' }}>{labels.imagesHint}</span>
      {images.length > 0 && (
        <div className="dalil-thumbs">
          {images.map((img) => (
            <div key={img.id} className="dalil-thumb">
              <img src={img.url} alt={img.name} />
              <button type="button" aria-label={labels.removeImage} onClick={() => remove(img)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div>
        <input
          ref={inputRef}
          id={`${id}-file`}
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          className="dalil-sr"
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="dalil-btn"
          disabled={images.length >= MAX_IMAGES}
          onClick={() => inputRef.current?.click()}
        >
          {labels.addImage}
        </button>
      </div>
      {note && <span className="dalil-error">{note}</span>}
    </div>
  )
}
