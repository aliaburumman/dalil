import { describe, expect, it } from 'vitest'
import type { DalilEvent } from '../src/payload'
import { buildShare, type ShareInput } from '../src/share'

const T = Date.UTC(2026, 9, 12, 14, 5, 33)
const URL_ = 'https://dalil.test/r/abc'
const click = (i: number, label = `Btn ${i}`): DalilEvent => ({ id: `c${i}`, t: T, type: 'click', label, tag: 'button', context: 'Add Payment' })
const fail: DalilEvent = {
  id: 'r1', t: T, type: 'request', method: 'post', url: 'https://api.x.test/Payment/Create', status: 500, durationMs: 5, outcome: 'http_error',
  requestId: 'req-111', requestBody: 'SECRETBODY', responseBody: 'SECRETRESP', extraHeaders: { 'X-Client-Type': 'HEADERVAL' }, hadAuth: true,
}
const base = (o: Partial<ShareInput> = {}): ShareInput => ({
  ref: 'SPACE-7', title: 'Cannot save', verdict: { kind: 'backend', headline: 'Backend error: 500 on POST /Payment/Create' },
  events: [{ id: 'n', t: T, type: 'nav', url: '/bookings?x=1' }, click(1, 'Save'), fail], pageUrl: 'https://p.test/payments', createdAt: T, url: URL_, ...o,
})

describe('buildShare', () => {
  it('builds title, html and text', () => {
    const s = buildShare(base())
    expect(s.title).toBe('SPACE-7: Cannot save')
    expect(s.html).toContain('<p><b>SPACE-7: Cannot save</b></p>')
    expect(s.html).toContain('<li>Opened /bookings?x=1</li>')
    expect(s.html).toContain('<li>Clicked Save on Add Payment</li>')
    expect(s.html).toContain('<p>POST /Payment/Create → 500 · X-Request-Id: req-111</p>')
    expect(s.html).toContain('Page: /payments · 2026-10-12T14:05Z')
    expect(s.text.split('\n')[0]).toBe('*SPACE-7: Cannot save*')
    expect(s.text).toContain('1. Opened /bookings?x=1')
    expect(s.text.split('\n').at(-1)).toBe(`Full evidence: ${URL_}`)
  })

  it('uses only b, p, ol, li, a, br tags', () => {
    const s = buildShare(base({ title: '<script>alert(1)</script><img src=x onerror=1>' }))
    const tags = [...s.html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase())
    expect(new Set(tags).size).toBeGreaterThan(0)
    for (const t of tags) expect(['b', 'p', 'ol', 'li', 'a', 'br']).toContain(t)
    expect(s.html).not.toContain('<script')
    expect(s.html).toContain('&lt;script&gt;')
  })

  it('escapes user text in steps and verdict', () => {
    const s = buildShare(base({ events: [click(1, '<b>x</b>"')], verdict: { kind: 'ux', headline: '<i>h</i>' } }))
    expect(s.html).not.toContain('<i>')
    expect(s.html).toContain('&lt;b&gt;x&lt;/b&gt;&quot;')
  })

  it('preserves Arabic text', () => {
    const s = buildShare(base({ title: 'لا يمكن الحفظ', events: [click(1, 'حفظ')] }))
    expect(s.title).toContain('لا يمكن الحفظ')
    expect(s.html).toContain('Clicked حفظ on Add Payment')
    expect(s.text).toContain('حفظ')
  })

  it('inserts a zero-width space after WhatsApp markup chars in text only', () => {
    const s = buildShare(base({ title: '*bold_ ~s~' }))
    expect(s.text).toContain('*SPACE-7: *​bold_​ ~​s~​*')
    expect(s.html).not.toContain('​')
    expect(s.title).toBe('SPACE-7: *bold_ ~s~')
  })

  it('caps at 5 steps and marks the rest with an ellipsis', () => {
    const s = buildShare(base({ events: Array.from({ length: 8 }, (_, i) => click(i)) }))
    expect((s.html.match(/<li>/g) ?? []).length).toBe(6)
    expect(s.html).toContain('<li>…</li>')
    expect(s.html).toContain('Btn 7')
    expect(s.html).not.toContain('Btn 2')
    const exactly = buildShare(base({ events: Array.from({ length: 5 }, (_, i) => click(i)) }))
    expect(exactly.html).not.toContain('…')
  })

  it('has no request line without a failed request', () => {
    const s = buildShare(base({ events: [click(1), { ...fail, outcome: 'ok', status: 200 }] }))
    expect(s.html).not.toContain('→')
    expect(s.text).not.toContain('→')
  })

  it('never leaks curl, headers, bodies or console/log text', () => {
    const noisy: DalilEvent[] = [
      fail,
      { id: 'e', t: T, type: 'error', source: 'console', message: 'CONSOLEMSG', stack: 'STACK' },
      { id: 'l', t: T, type: 'log', level: 'error', message: 'LOGMSG', data: 'LOGDATA' },
    ]
    const s = buildShare(base({ events: noisy }))
    for (const bad of ['curl', 'SECRETBODY', 'SECRETRESP', 'HEADERVAL', 'X-Client-Type', 'Authorization', 'CONSOLEMSG', 'STACK', 'LOGMSG', 'LOGDATA']) {
      expect(s.html).not.toContain(bad)
      expect(s.text).not.toContain(bad)
    }
  })

  it('puts the link last and survives missing events and verdict', () => {
    const s = buildShare(base({ events: undefined, verdict: null }))
    expect(s.html.endsWith('<p><a href="https://dalil.test/r/abc">Full evidence (screenshot, replay)</a></p>')).toBe(true)
    expect(s.html).not.toContain('<ol>')
    expect(s.text.split('\n')).toHaveLength(3)
  })

  it('truncates the title to 140 characters', () => {
    expect(buildShare(base({ title: 'x'.repeat(500) })).title.length).toBeLessThanOrEqual('SPACE-7: '.length + 140)
  })
})

describe('buildShare evidence link', () => {
  it('keeps ?play=failure in both html and text links', () => {
    const s = buildShare(base({ url: `${URL_}?play=failure` }))
    expect(s.html).toContain('href="https://dalil.test/r/abc?play=failure"')
    expect(s.text.endsWith('Full evidence: https://dalil.test/r/abc?play=failure')).toBe(true)
  })
})
