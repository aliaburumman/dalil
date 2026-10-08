import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { canvasToBlob, dataUrlToBlob, loadImage } from './images'
import type { Labels } from './labels'

type Tool = 'pen' | 'rect' | 'blur'
type Pt = { x: number; y: number }
type Shape =
  | { tool: 'pen'; points: Pt[] }
  | { tool: 'rect' | 'blur'; a: Pt; b: Pt }

export interface AnnotatorHandle {
  /** JPEG of the screenshot with annotations burnt in. */
  toBlob(): Promise<Blob>
}

interface Props {
  src: string
  labels: Labels
}

const STROKE = '#ef4444'

function pixelate(ctx: CanvasRenderingContext2D, base: HTMLImageElement, a: Pt, b: Pt) {
  const x = Math.round(Math.min(a.x, b.x))
  const y = Math.round(Math.min(a.y, b.y))
  const w = Math.round(Math.abs(a.x - b.x))
  const h = Math.round(Math.abs(a.y - b.y))
  if (w < 2 || h < 2) return
  const block = 12
  const tmp = document.createElement('canvas')
  tmp.width = Math.max(1, Math.ceil(w / block))
  tmp.height = Math.max(1, Math.ceil(h / block))
  const t = tmp.getContext('2d')
  if (!t) return
  t.drawImage(base, x, y, w, h, 0, 0, tmp.width, tmp.height)
  const prev = ctx.imageSmoothingEnabled
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h)
  ctx.imageSmoothingEnabled = prev
}

function draw(ctx: CanvasRenderingContext2D, base: HTMLImageElement, shapes: Shape[]) {
  ctx.drawImage(base, 0, 0)
  const lw = Math.max(2, Math.round(base.naturalWidth / 400))
  ctx.lineWidth = lw
  ctx.strokeStyle = STROKE
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // Blur first so pen/rect strokes stay visible on top of it.
  for (const s of shapes) if (s.tool === 'blur') pixelate(ctx, base, s.a, s.b)
  for (const s of shapes) {
    if (s.tool === 'pen') {
      const [first, ...rest] = s.points
      if (!first) continue
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      for (const p of rest) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else if (s.tool === 'rect') {
      ctx.strokeRect(s.a.x, s.a.y, s.b.x - s.a.x, s.b.y - s.a.y)
    }
  }
}

export const Annotator = forwardRef<AnnotatorHandle, Props>(function Annotator({ src, labels }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const baseRef = useRef<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [shapes, setShapes] = useState<Shape[]>([])
  const drawing = useRef<Shape | null>(null)

  const redraw = useCallback((list: Shape[]) => {
    const canvas = canvasRef.current
    const base = baseRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !base || !ctx) return
    draw(ctx, base, list)
  }, [])

  useEffect(() => {
    let alive = true
    loadImage(src)
      .then((img) => {
        if (!alive || !canvasRef.current) return
        baseRef.current = img
        canvasRef.current.width = img.naturalWidth
        canvasRef.current.height = img.naturalHeight
        redraw([])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [src, redraw])

  useEffect(() => {
    redraw(shapes)
  }, [shapes, redraw])

  useImperativeHandle(
    ref,
    () => ({
      async toBlob() {
        const canvas = canvasRef.current
        if (canvas && baseRef.current && canvas.getContext('2d')) {
          redraw(shapes)
          const blob = await canvasToBlob(canvas, 0.8)
          if (blob) return blob
        }
        return dataUrlToBlob(src)
      },
    }),
    [shapes, src, redraw],
  )

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const canvas = e.currentTarget
    const r = canvas.getBoundingClientRect()
    const sx = r.width ? canvas.width / r.width : 1
    const sy = r.height ? canvas.height / r.height : 1
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = toPoint(e)
    drawing.current = tool === 'pen' ? { tool, points: [p] } : { tool, a: p, b: p }
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = drawing.current
    if (!cur) return
    const p = toPoint(e)
    if (cur.tool === 'pen') cur.points.push(p)
    else cur.b = p
    redraw([...shapes, cur])
  }
  const onUp = () => {
    const cur = drawing.current
    drawing.current = null
    if (cur) setShapes((s) => [...s, cur])
  }

  const tools: [Tool, string][] = [
    ['pen', labels.toolPen],
    ['rect', labels.toolRect],
    ['blur', labels.toolBlur],
  ]

  return (
    <div>
      <div className="dalil-tools" role="toolbar" aria-label={labels.screenshot}>
        {tools.map(([t, label]) => (
          <button
            key={t}
            type="button"
            className="dalil-btn"
            aria-pressed={tool === t}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="dalil-btn"
          disabled={shapes.length === 0}
          onClick={() => setShapes((s) => s.slice(0, -1))}
        >
          {labels.undo}
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="dalil-canvas"
        aria-label={labels.screenshot}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  )
})
