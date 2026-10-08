import { describe, expect, it } from 'vitest'
import { fitBody, type SizedPart } from './assemble'

const part = (name: string, size: number): SizedPart => ({ part: name, name, blob: new Blob([new Uint8Array(size)]) })

describe('fitBody', () => {
  it('keeps everything when it fits', () => {
    const r = fitBody({ reportBytes: 1000, images: [part('image_0', 100)], autos: [part('auto_0', 100)], replay: part('replay', 100), limit: 10_000 })
    expect(r.replay).toBeDefined()
    expect(r.autos).toHaveLength(1)
    expect(r.replayDropped).toBe(false)
  })

  it('drops the replay first', () => {
    const r = fitBody({ reportBytes: 1000, images: [part('image_0', 1000)], autos: [part('auto_0', 1000)], replay: part('replay', 5000), limit: 6000 })
    expect(r.replay).toBeUndefined()
    expect(r.replayDropped).toBe(true)
    expect(r.autos).toHaveLength(1)
  })

  it('then drops the oldest auto-snapshot, never the images', () => {
    const autos = [part('a_old', 3000), part('a_mid', 3000), part('a_new', 3000)]
    const r = fitBody({ reportBytes: 1000, images: [part('image_0', 3000)], autos, replay: part('replay', 3000), limit: 9000 })
    expect(r.replayDropped).toBe(true)
    expect(r.autos.map((a) => a.part)).toEqual(['a_new'])
    expect(r.autosDropped).toBe(2)
  })
})
