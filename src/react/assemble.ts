// Fits the optional parts (replay, auto-snapshots) into the collector's body limit.
// Order of sacrifice: the replay first, then the oldest auto-snapshot.
import { LIMITS } from '../core'

export interface SizedPart {
  part: string
  name: string
  blob: Blob
}

/** Multipart framing + headers per part, generously. */
const OVERHEAD_PER_PART = 400

export interface FitResult<A extends SizedPart> {
  autos: A[]
  replay: SizedPart | undefined
  replayDropped: boolean
  autosDropped: number
}

export function fitBody<A extends SizedPart>(args: {
  /** report JSON size, bytes */
  reportBytes: number
  /** image_0..5, never dropped here */
  images: SizedPart[]
  /** oldest first */
  autos: A[]
  replay?: SizedPart
  limit?: number
}): FitResult<A> {
  const limit = args.limit ?? LIMITS.bodyBytes
  const sum = (autos: A[], replay?: SizedPart) =>
    args.reportBytes +
    OVERHEAD_PER_PART +
    [...args.images, ...autos, ...(replay ? [replay] : [])].reduce((n, p) => n + p.blob.size + OVERHEAD_PER_PART, 0)
  let autos = args.autos
  let replay = args.replay
  let replayDropped = false
  if (replay && sum(autos, replay) > limit) {
    replay = undefined
    replayDropped = true
  }
  let autosDropped = 0
  while (autos.length && sum(autos, replay) > limit) {
    autos = autos.slice(1)
    autosDropped++
  }
  return { autos, replay, replayDropped, autosDropped }
}
