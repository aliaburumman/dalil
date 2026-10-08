// @vitest-environment jsdom
// Runs the REAL rrweb recorder in jsdom to prove masking end to end.
import { afterEach, describe, expect, it } from 'vitest'
import { __resetForTests, init } from '../core'
import { startReplay, type ReplayHandle } from './replay'

async function gunzip(blob: Blob): Promise<string> {
  const buf = await new Promise<Uint8Array>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer))
    fr.onerror = () => reject(fr.error)
    fr.readAsArrayBuffer(blob)
  })
  const ds = new DecompressionStream('gzip')
  const w = ds.writable.getWriter()
  void w.write(buf).then(() => w.close())
  const reader = ds.readable.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

let handle: ReplayHandle | undefined
afterEach(() => {
  handle?.stop()
  __resetForTests()
  document.body.innerHTML = ''
})

describe('replay with the real recorder', () => {
  it('keeps visible text but hides typed values, contenteditable text, and token URLs', async () => {
    init({ project: 'p', publicKey: 'k', endpoint: 'https://x.test/v1/reports' })
    document.body.innerHTML = `
      <table><tr><td>Visible balance 120 JOD</td></tr></table>
      <input id="f" type="text" value="">
      <input id="pw" type="password" value="initialpw">
      <textarea id="ta">textarea-secret-9</textarea>
      <div contenteditable="true">contenteditable-secret-7</div>
      <p data-dalil-mask>masked-card-4111</p>
      <img src="https://cdn.test/a.png?X-Amz-Signature=sigsecret123&w=1">
      <pre>jwt eyJhbGciOi.eyJzdWIiOjF9.abcSIG-123 end</pre>`
    handle = startReplay()
    await new Promise((r) => setTimeout(r, 50))
    const input = document.getElementById('f') as HTMLInputElement
    input.value = 'typed-secret-42'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const out = await handle.prepare()
    expect('blob' in out).toBe(true)
    if (!('blob' in out)) return
    const json = await gunzip(out.blob)
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).toContain('Visible balance 120 JOD')
    expect(json).toContain('"source":5') // the typing WAS recorded, just masked
    expect(json).toContain('https://cdn.test/a.png?[REDACTED]')
    expect(json).toContain('[JWT]')
    for (const secret of ['typed-secret-42', 'initialpw', 'textarea-secret-9', 'contenteditable-secret-7', 'masked-card-4111', 'sigsecret123', 'eyJhbGciOi.eyJzdWIiOjF9.abcSIG-123']) {
      expect(json).not.toContain(secret)
    }
    expect(out.meta).toMatchObject({ part: 'replay', rrweb: expect.any(String) })
    expect(out.meta.events).toBeGreaterThan(1)
  })
})
