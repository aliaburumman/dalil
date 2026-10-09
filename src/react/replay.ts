// Lazy chunk: DOM session replay (rrweb recorder only). Loaded in an idle callback
// after init, only while the widget is enabled. Events live in memory as at most two
// whole segments (each starting at Meta + FullSnapshot); nothing is persisted.
import { record } from '@rrweb/record'
import { LIMITS, onEvent, redactText, redactUrl, type DalilEvent, type ReplayMeta } from '../core'

/** Version of the bundled recorder, so the report page can pick a matching player. */
export const RRWEB_VERSION = '2.1.7'

/** The slice of an rrweb event this module relies on. */
interface RrEvent {
  type: number
  timestamp: number
  data?: unknown
}

const META = 4
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3
const MAX_SEGMENTS = 2
export const DEFAULT_REPLAY_SECONDS = 30
const MIN_REPLAY_SECONDS = 15
const MAX_REPLAY_SECONDS = 120

/** Guaranteed minimum seconds of replay; clamped to [15, 120], default 30. The held window is between 1x and 2x this. */
export function clampReplaySeconds(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_REPLAY_SECONDS
  return Math.min(MAX_REPLAY_SECONDS, Math.max(MIN_REPLAY_SECONDS, n))
}
const MAX_EVENTS = 30_000
const MAX_EST_BYTES = 15 * 1024 * 1024
const MAX_PENDING_MARKERS = 100
const CHUNK_EVENTS = 500
const FAILED = new Set(['http_error', 'app_error', 'network', 'timeout'])

interface Segment {
  events: RrEvent[]
  bytes: number
}

export type ReplayStatus =
  | { state: 'recording' }
  | { state: 'unsupported' }
  | { state: 'stopped'; reason: string }

export type PreparedReplay = { blob: Blob; meta: ReplayMeta } | { error: string }

export interface ReplayHandle {
  stop(): void
  status(): ReplayStatus
  /** What would be sent right now, or null when nothing is held. */
  info(): { durationMs: number; events: number } | null
  /** Serialise, scrub, gzip and size-check the held segments. */
  prepare(): Promise<PreparedReplay>
}

// Rough cost of an event without stringifying it (only full snapshots are measured).
function estimate(ev: RrEvent): number {
  if (ev.type === FULL_SNAPSHOT) {
    try {
      return JSON.stringify(ev).length
    } catch {
      return 1_000_000
    }
  }
  if (ev.type === INCREMENTAL) {
    const d = ev.data as { source?: number; adds?: unknown[]; texts?: unknown[]; attributes?: unknown[]; removes?: unknown[] } | undefined
    if (d?.source === 0) {
      return 200 + (d.adds?.length ?? 0) * 400 + (d.texts?.length ?? 0) * 100 + (d.attributes?.length ?? 0) * 100 + (d.removes?.length ?? 0) * 50
    }
  }
  return 150
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const SECRET_QUERY = /[?&](x-amz-[^=&]*|signature|sig|expires|token|key|credential|auth|access_token)=/i
const URL_ATTR = /"(src|href|srcset|poster|action|data-src|xlink:href)":"((?:[^"\\]|\\.)*)"/g

/** Strips tokens/signatures from a URL found in a recorded attribute. */
function scrubUrl(u: string): string {
  const r = redactUrl(u)
  if (SECRET_QUERY.test(r)) return r.slice(0, r.indexOf('?')) + '?[REDACTED]'
  return r
}

/** Scrubs one chunk of serialised events: JWT/Bearer text and query secrets in URL attributes. */
export function scrubChunk(json: string): string {
  const withUrls = json.replace(URL_ATTR, (m, attr: string, raw: string) => {
    if (!raw.includes('?') && !raw.includes('eyJ')) return m
    let value: string
    try {
      value = JSON.parse(`"${raw}"`) as string
    } catch {
      return m
    }
    const scrubbed = value.replace(/(?:https?:)?\/\/[^\s,]+|[^\s,]*\?[^\s,]+/g, (u) => scrubUrl(u))
    return `"${attr}":${JSON.stringify(scrubbed)}`
  })
  return redactText(withUrls)
}

async function gzipChunks(chunks: AsyncIterable<string>): Promise<{ blob: Blob; rawBytes: number } | 'too_big'> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  const out: Uint8Array[] = []
  let gz = 0
  const reading = (async () => {
    const reader = cs.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out.push(value)
      gz += value.length
    }
  })()
  const enc = new TextEncoder()
  let raw = 0
  try {
    for await (const chunk of chunks) {
      const bytes = enc.encode(chunk)
      raw += bytes.length
      if (raw > LIMITS.replayDecompressedBytes) {
        await writer.abort('too big').catch(() => {})
        await reading.catch(() => {})
        return 'too_big'
      }
      await writer.write(bytes)
    }
    await writer.close()
    await reading
  } catch (err) {
    await reading.catch(() => {})
    throw err
  }
  return { blob: new Blob(out as BlobPart[], { type: 'application/gzip' }), rawBytes: raw }
}

async function* serialise(segments: Segment[]): AsyncGenerator<string> {
  let first = true
  yield '['
  for (const seg of segments) {
    for (let i = 0; i < seg.events.length; i += CHUNK_EVENTS) {
      const slice = seg.events.slice(i, i + CHUNK_EVENTS)
      const json = slice.map((e) => JSON.stringify(e)).join(',')
      yield (first ? '' : ',') + scrubChunk(json)
      first = false
      await tick() // yield to the event loop between chunks
    }
  }
  yield ']'
}

/**
 * Starts recording and returns the handle. With no CompressionStream (old Safari) the
 * handle is inactive so no memory is spent on a recording that could never be sent.
 */
export function startReplay(opts: { replaySeconds?: number } = {}): ReplayHandle {
  const checkoutMs = clampReplaySeconds(opts.replaySeconds) * 1000
  const supported = typeof CompressionStream !== 'undefined'
  let segments: Segment[] = []
  let totalEvents = 0
  let totalBytes = 0
  let status: ReplayStatus = supported ? { state: 'recording' } : { state: 'unsupported' }
  let stopRecording: (() => void) | undefined
  let ready = false
  const pendingMarkers: { kind: string; label: string; eventId?: string }[] = []
  let offEvent: (() => void) | undefined

  const recompute = () => {
    totalEvents = segments.reduce((n, s) => n + s.events.length, 0)
    totalBytes = segments.reduce((n, s) => n + s.bytes, 0)
  }

  const halt = (reason: string) => {
    status = { state: 'stopped', reason }
    segments = []
    pendingMarkers.length = 0
    recompute()
    try {
      stopRecording?.()
    } catch {
      /* ignore */
    }
    stopRecording = undefined
    offEvent?.()
    offEvent = undefined
  }

  const addMarker = (m: { kind: string; label: string; eventId?: string }) => {
    if (!ready) {
      if (pendingMarkers.length < MAX_PENDING_MARKERS) pendingMarkers.push(m)
      return
    }
    try {
      record.addCustomEvent('dalil', m)
    } catch {
      /* recorder not accepting events right now */
    }
  }

  const flushMarkers = () => {
    ready = true
    for (const m of pendingMarkers.splice(0)) addMarker(m)
  }

  const emit = (ev: RrEvent) => {
    if (status.state !== 'recording') return
    if (ev.type === META || segments.length === 0) {
      segments.push({ events: [], bytes: 0 })
      while (segments.length > MAX_SEGMENTS) segments.shift()
    }
    const seg = segments[segments.length - 1]!
    seg.events.push(ev)
    seg.bytes += estimate(ev)
    recompute()
    // Past the cap the older segment goes first; a single oversized segment ends recording.
    while ((totalEvents > MAX_EVENTS || totalBytes > MAX_EST_BYTES) && segments.length > 1) {
      segments.shift()
      recompute()
    }
    if (totalEvents > MAX_EVENTS || totalBytes > MAX_EST_BYTES) {
      halt('Replay stopped: this page is too heavy to record')
      return
    }
    if (ev.type === FULL_SNAPSHOT && !ready) flushMarkers()
  }

  if (supported) {
    try {
      stopRecording =
        record({
          emit: (ev: unknown) => emit(ev as RrEvent),
          maskAllInputs: true,
          maskInputOptions: {
            color: true,
            date: true,
            'datetime-local': true,
            email: true,
            month: true,
            number: true,
            range: true,
            search: true,
            tel: true,
            text: true,
            time: true,
            url: true,
            week: true,
            textarea: true,
            select: true,
            password: true,
          },
          maskTextSelector: '[data-dalil-mask], [contenteditable]',
          blockSelector: 'iframe,canvas,[data-dalil-ignore]',
          inlineStylesheet: true,
          recordCanvas: false,
          collectFonts: false,
          sampling: { mousemove: 50, scroll: 150, input: 'last' },
          checkoutEveryNms: checkoutMs,
        }) ?? undefined
    } catch {
      status = { state: 'stopped', reason: 'Replay could not start' }
    }

    // Mirror the Dalil timeline into the replay as clickable markers.
    offEvent = onEvent((e: DalilEvent) => {
      if (status.state !== 'recording') return
      if (e.type === 'request' && FAILED.has(e.outcome)) {
        let path = e.url
        try {
          path = new URL(e.url).pathname
        } catch {
          /* keep as is */
        }
        addMarker({ kind: 'request', label: `${e.method} ${path} → ${e.status || e.outcome}`, eventId: e.id })
      } else if (e.type === 'error') {
        addMarker({ kind: 'error', label: e.message.slice(0, 200), eventId: e.id })
      } else if (e.type === 'log' && e.level === 'error') {
        addMarker({ kind: e.message.startsWith('Toast: ') ? 'toast' : 'log', label: e.message.slice(0, 200), eventId: e.id })
      }
    })
  }

  const held = () => segments.filter((s) => s.events.length)

  return {
    stop() {
      status = status.state === 'recording' ? { state: 'stopped', reason: 'Replay stopped' } : status
      segments = []
      pendingMarkers.length = 0
      recompute()
      try {
        stopRecording?.()
      } catch {
        /* ignore */
      }
      stopRecording = undefined
      offEvent?.()
      offEvent = undefined
    },
    status: () => status,
    info() {
      const segs = held()
      if (status.state !== 'recording' || !segs.length) return null
      const first = segs[0]!.events[0]!.timestamp
      const lastSeg = segs[segs.length - 1]!
      const last = lastSeg.events[lastSeg.events.length - 1]!.timestamp
      return { durationMs: Math.max(0, last - first), events: segs.reduce((n, s) => n + s.events.length, 0) }
    },
    async prepare() {
      if (status.state === 'unsupported') return { error: 'unsupported' }
      if (status.state === 'stopped') return { error: status.reason }
      let segs = held()
      while (segs.length) {
        let result: Awaited<ReturnType<typeof gzipChunks>>
        try {
          result = await gzipChunks(serialise(segs))
        } catch {
          return { error: 'Replay could not be prepared' }
        }
        if (result !== 'too_big' && result.blob.size <= LIMITS.replayBytes) {
          const first = segs[0]!.events[0]!.timestamp
          const lastSeg = segs[segs.length - 1]!
          const last = lastSeg.events[lastSeg.events.length - 1]!.timestamp
          return {
            blob: result.blob,
            meta: {
              part: 'replay',
              durationMs: Math.max(0, last - first),
              events: segs.reduce((n, s) => n + s.events.length, 0),
              bytes: result.blob.size,
              rrweb: RRWEB_VERSION,
            },
          }
        }
        if (segs.length > 1) segs = segs.slice(1) // drop the older whole segment, never cut mid-segment
        else return { error: 'Recording too large to send' }
      }
      return { error: 'No recording yet' }
    },
  }
}
