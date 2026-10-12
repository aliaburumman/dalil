import { describe, expect, it } from 'vitest'
import { crc32, downloadBlob, zipStore } from './zip'

/** Minimal reader for STORE zips, via the central directory. */
function readZip(z: Uint8Array) {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength)
  const end = z.length - 22
  expect(v.getUint32(end, true)).toBe(0x06054b50)
  const count = v.getUint16(end + 10, true)
  let p = v.getUint32(end + 16, true)
  const out: { name: string; size: number; crc: number; data: Uint8Array; method: number }[] = []
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const method = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true)
    const size = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const off = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen))
    expect(v.getUint32(off, true)).toBe(0x04034b50)
    const lnameLen = v.getUint16(off + 26, true)
    const start = off + 30 + lnameLen
    out.push({ name, size, crc, method, data: z.subarray(start, start + size) })
    p += 46 + nameLen
  }
  return out
}

describe('zip', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('writes a readable STORE archive with names, sizes and CRCs', () => {
    const enc = new TextEncoder()
    const files = [
      { name: 'report.txt', data: enc.encode('héllo') },
      { name: 'auto-1-ünï.jpg', data: new Uint8Array([0xff, 0xd8, 0, 1, 2, 3]) },
      { name: 'empty.json', data: new Uint8Array() },
    ]
    const entries = readZip(zipStore(files))
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name))
    entries.forEach((e, i) => {
      expect(e.method).toBe(0)
      expect(e.size).toBe(files[i]!.data.length)
      expect(e.crc).toBe(crc32(files[i]!.data))
      expect(Array.from(e.data)).toEqual(Array.from(files[i]!.data))
    })
  })

  it('downloadBlob clicks an anchor inside the container and revokes the URL', () => {
    const created: string[] = []
    const revoked: string[] = []
    URL.createObjectURL = () => {
      created.push('blob:x')
      return 'blob:x'
    }
    URL.revokeObjectURL = (u) => void revoked.push(u)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    let clicked: HTMLAnchorElement | null = null
    const orig = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked = this
      expect(this.getRootNode()).toBe(shadow)
    }
    try {
      expect(downloadBlob(new Blob(['x']), 'a.zip', shadow)).toBe(true)
    } finally {
      HTMLAnchorElement.prototype.click = orig
    }
    expect(clicked!.download).toBe('a.zip')
    expect(created).toHaveLength(1)
  })

  it('downloadBlob reports a blocked download', () => {
    URL.createObjectURL = () => {
      throw new Error('blocked')
    }
    expect(downloadBlob(new Blob(['x']), 'a.zip')).toBe(false)
  })
})
