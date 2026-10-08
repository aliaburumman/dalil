// Image helpers for the dialog (lazy chunk).
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_DIM = 2400

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  const mime = /data:([^;,]+)/.exec(head)?.[1] ?? 'image/jpeg'
  const bin = atob(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Image failed to load'))
    img.src = src
  })
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
    } catch {
      resolve(null)
    }
  })
}

/** Re-encodes any image file to a JPEG of at most 2 MB, shrinking as needed. */
export async function toJpegUnder2MB(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    let scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight, 1))
    let quality = 0.85
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, quality)
      if (!blob) throw new Error('Encode failed')
      if (blob.size <= MAX_IMAGE_BYTES) return blob
      quality = Math.max(0.5, quality - 0.15)
      scale *= 0.75
    }
    throw new Error('Image too large')
  } finally {
    URL.revokeObjectURL(url)
  }
}
