import { describe, expect, it } from 'vitest'
import { describeBody, describeFormData, isSecretKey, redactHeaders, redactJsonString, redactText, redactUrl } from './redact'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123'

describe('redactHeaders', () => {
  it('redacts auth, cookie and secret-looking headers', () => {
    const out = redactHeaders(
      new Headers({
        Authorization: 'Bearer x',
        Cookie: 'sid=1',
        'X-Api-Key': 'k',
        'X-Session-Id': 's',
        'Content-Type': 'application/json',
        'X-Client-Type': 'web',
      }),
    )
    expect(out.authorization).toBe('[REDACTED]')
    expect(out.cookie).toBe('[REDACTED]')
    expect(out['x-api-key']).toBe('[REDACTED]')
    expect(out['x-session-id']).toBe('[REDACTED]')
    expect(out['content-type']).toBe('application/json')
    expect(out['x-client-type']).toBe('web')
  })
  it('accepts plain objects and arrays', () => {
    expect(redactHeaders({ 'X-Csrf-Token': 'a', Accept: '*/*' })).toEqual({ 'X-Csrf-Token': '[REDACTED]', Accept: '*/*' })
    expect(redactHeaders([['authorization', 'x']])).toEqual({ authorization: '[REDACTED]' })
  })
})

describe('key matching', () => {
  it.each(['password', 'newPassword', 'pass', 'otp', 'pin', 'token', 'accessToken', 'refresh_token', 'clientSecret', 'cvv', 'cardNumber', 'card_number', 'IBAN', 'otpCode'])(
    'redacts %s',
    (k) => expect(isSecretKey(k)).toBe(true),
  )
  it.each(['isPinned', 'shipping', 'spinner', 'passport', 'amount', 'opinion', 'tokenize2'])('keeps %s', (k) =>
    expect(isSecretKey(k)).toBe(false),
  )
  it('honours extra keys', () => {
    expect(isSecretKey('nationalId', ['nationalId'])).toBe(true)
    expect(isSecretKey('nationalId')).toBe(false)
  })
})

describe('redactJsonString', () => {
  it('redacts nested keys at any depth and leaves anchored negatives', () => {
    const src = JSON.stringify({
      query: { user: { password: 'p@ss', profile: { accessToken: 'abc' } }, isPinned: true, shipping: 'x', spinner: 1 },
      list: [{ otp: '1234' }, { pin: '9999', name: 'Ali' }],
    })
    const out = JSON.parse(redactJsonString(src))
    expect(out.query.user.password).toBe('[REDACTED]')
    expect(out.query.user.profile.accessToken).toBe('[REDACTED]')
    expect(out.query.isPinned).toBe(true)
    expect(out.query.shipping).toBe('x')
    expect(out.query.spinner).toBe(1)
    expect(out.list[0].otp).toBe('[REDACTED]')
    expect(out.list[1].pin).toBe('[REDACTED]')
    expect(out.list[1].name).toBe('Ali')
  })
  it('redacts a whole object under a secret key', () => {
    expect(JSON.parse(redactJsonString('{"token":{"value":"x"}}')).token).toBe('[REDACTED]')
  })
  it('scrubs JWTs inside values', () => {
    const out = redactJsonString(JSON.stringify({ message: `bad ${JWT} here`, data: { jwt: JWT } }))
    expect(out).not.toContain('eyJ')
    expect(out).toContain('[JWT]')
  })
  it('truncates at 10 KB', () => {
    const out = redactJsonString(JSON.stringify({ a: 'x'.repeat(20_000) }))
    expect(out.length).toBeLessThan(10_300)
    expect(out.endsWith('…[truncated]')).toBe(true)
  })
  it('handles form-encoded and plain text', () => {
    expect(redactJsonString('user=ali&password=secret')).toBe('user=ali&password=[REDACTED]')
    expect(redactJsonString(`oops ${JWT}`)).toBe('oops [JWT]')
  })
})

describe('redactText', () => {
  it('scrubs JWTs and Bearer values in console text', () => {
    const out = redactText(`Request failed: Authorization: Bearer abc.def123 and ${JWT}`)
    expect(out).toBe('Request failed: Authorization: Bearer [REDACTED] and [JWT]')
  })
})

describe('redactUrl', () => {
  it('redacts query params by key, scrubs JWTs, drops hash', () => {
    const out = redactUrl(`https://api.x.com/a/b?token=abc&page=2&isPinned=1&x=${JWT}#frag`)
    expect(out).toBe('https://api.x.com/a/b?token=[REDACTED]&page=2&isPinned=1&x=[JWT]')
  })
  it('keeps relative paths relative', () => {
    expect(redactUrl('/reset/' + JWT + '?otp=1')).toBe('/reset/[JWT]?otp=[REDACTED]')
  })
})

describe('multipart descriptor', () => {
  it('describes files and field names, never values', () => {
    const fd = new FormData()
    fd.append('amount', '50')
    fd.append('password', 'hunter2')
    fd.append('receipt', new File([new Uint8Array(214 * 1024)], 'receipt.jpg', { type: 'image/jpeg' }))
    const d = describeFormData(fd)
    expect(d).toBe('[multipart] amount, password, receipt=[file: receipt.jpg, 214 KB]')
    expect(d).not.toContain('hunter2')
    expect(d).not.toContain('50')
    expect(describeBody(fd).contentType).toBe('multipart/form-data')
  })
  it('describes blobs and binary', () => {
    expect(describeBody(new Blob(['abc'], { type: 'text/csv' })).body).toBe('[blob: text/csv, 1 KB]')
    expect(describeBody(new ArrayBuffer(2048)).body).toBe('[binary: 2 KB]')
  })
})
