// COPY of ../../src/core/limits.ts. The worker can't import from the client package;
// change both together.

export const LIMITS = {
  /** report part (JSON) */
  reportBytes: 1_000_000,
  /** on-open screenshot + tester images: image_0..image_5 */
  images: 6,
  imageBytes: 2_000_000,
  /** automatic failure snapshots: auto_0..auto_2 */
  autoSnaps: 3,
  autoSnapBytes: 400_000,
  /** gzipped rrweb events in part "replay" */
  replayBytes: 5_000_000,
  replayDecompressedBytes: 40_000_000,
  /** whole multipart body */
  bodyBytes: 8_000_000,
} as const

export const IMAGE_PART = /^image_[0-5]$/
export const AUTO_PART = /^auto_[0-2]$/
export const REPLAY_PART = 'replay'
