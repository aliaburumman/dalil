// Pure text helpers shared by the worker and the widget. No DOM or Workers types.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape any value for HTML text or a double/single-quoted attribute. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Path (+ search) of an absolute or relative URL; the input unchanged if unparsable. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url, 'http://x')
    return u.pathname + u.search
  } catch {
    return url
  }
}
