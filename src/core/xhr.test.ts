import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetForTests, init, snapshot } from './recorder'
import type { DalilConfig, RequestEvent } from './types'

const API = 'https://api.example.com'
const cfg: DalilConfig = { project: 'p', publicKey: 'k', endpoint: 'https://dalil.example.com/v1/reports', apiOrigins: [API] }

type Listener = (ev: unknown) => void

/** Minimal XHR double: no network, events fired by the test. */
class FakeXHR {
  static instances: FakeXHR[] = []
  onload: Listener | null = null
  onerror: Listener | null = null
  onreadystatechange: Listener | null = null
  responseType: XMLHttpRequestResponseType = ''
  status = 0
  readyState = 0
  _response: unknown = null
  _text = ''
  _headers: Record<string, string> = {}
  sentHeaders: [string, string][] = []
  sentBody: unknown
  responseTextReads = 0
  responseReads = 0
  private listeners: Record<string, Listener[]> = {}
  private opened = false
  private done = false

  constructor() {
    FakeXHR.instances.push(this)
  }
  get response(): unknown {
    this.responseReads++
    return this._response
  }
  get responseText(): string {
    if (this.responseType !== '' && this.responseType !== 'text') throw new DOMException('InvalidStateError')
    this.responseTextReads++
    return this._text
  }
  open(_m: string, _u: string | URL, ..._rest: unknown[]) {
    this.opened = true
    this.done = false
    this.readyState = 1
  }
  setRequestHeader(n: string, v: string) {
    this.sentHeaders.push([n, v])
  }
  send(body?: unknown) {
    this.sentBody = body
  }
  abort() {
    if (this.opened && !this.done) {
      this.done = true
      this.readyState = 0
      this.fire('abort')
    }
  }
  addEventListener(t: string, fn: Listener) {
    ;(this.listeners[t] ??= []).push(fn)
  }
  removeEventListener() {}
  getResponseHeader(n: string) {
    return this._headers[n.toLowerCase()] ?? null
  }
  private fire(t: string) {
    const on = (this as unknown as Record<string, Listener | null>)['on' + t]
    on?.({ type: t })
    for (const l of this.listeners[t] ?? []) l({ type: t })
  }
  // ---- test drivers ----
  respond(status: number, body: unknown, contentType = 'application/json') {
    this.done = true
    this.status = status
    this.readyState = 4
    this._headers['content-type'] = contentType
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    this._text = text
    this._response = this.responseType === 'json' ? (typeof body === 'string' ? JSON.parse(body) : body) : this.responseType === '' || this.responseType === 'text' ? text : body
    this.fire('readystatechange')
    this.fire('load')
  }
  networkError() {
    this.done = true
    this.readyState = 4
    this.status = 0
    this.fire('readystatechange')
    this.fire('error')
  }
  timeoutNow() {
    this.done = true
    this.readyState = 4
    this.status = 0
    this.fire('readystatechange')
    this.fire('timeout')
  }
}

let realXhr: typeof XMLHttpRequest
const reqs = () => snapshot().events.filter((e): e is RequestEvent => e.type === 'request')
const start = (method: string, url: string, headers: [string, string][] = [], body?: unknown, rt: XMLHttpRequestResponseType = '') => {
  const x = new XMLHttpRequest() as unknown as FakeXHR
  x.open(method, url)
  x.responseType = rt
  for (const [k, v] of headers) x.setRequestHeader(k, v)
  x.send(body)
  return x
}

beforeEach(() => {
  FakeXHR.instances = []
  realXhr = window.XMLHttpRequest
  ;(window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR
  init(cfg)
})
afterEach(() => {
  __resetForTests()
  window.XMLHttpRequest = realXhr
})

describe('XHR patch', () => {
  it('records ok, http_error and app_error', () => {
    start('GET', `${API}/a`).respond(200, { success: true })
    start('GET', `${API}/b`).respond(500, { message: 'boom' })
    start('POST', `${API}/c`).respond(200, { success: false, message: 'Nope' })
    const [a, b, c] = reqs()
    expect([a!.outcome, a!.status]).toEqual(['ok', 200])
    expect([b!.outcome, b!.status]).toEqual(['http_error', 500])
    expect([c!.outcome, c!.status]).toEqual(['app_error', 200])
    expect(a!.method).toBe('GET')
    expect(a!.url).toBe(`${API}/a`)
  })

  it('adds X-Request-Id via setRequestHeader only for apiOrigins, and keeps a host-supplied one', () => {
    const a = start('GET', `${API}/x`)
    expect(a.sentHeaders.map(([n]) => n)).toEqual(['X-Request-Id'])
    const id = a.sentHeaders[0]![1]
    a.respond(200, { success: true })
    expect(reqs()[0]!.requestId).toBe(id)
    const other = start('GET', 'https://cdn.example.org/y')
    expect(other.sentHeaders).toEqual([])
    const own = start('GET', `${API}/z`, [['X-Request-Id', 'mine']])
    expect(own.sentHeaders).toEqual([['X-Request-Id', 'mine']])
    own.respond(200, {})
    expect(reqs().at(-1)!.requestId).toBe('mine')
  })

  it('does not record the dalil endpoint itself', () => {
    start('POST', 'https://dalil.example.com/v1/reports', [], '{}').respond(200, { success: true })
    expect(reqs()).toHaveLength(0)
  })

  it('captures and redacts the request body', () => {
    const x = start('POST', `${API}/login`, [['Content-Type', 'application/json']], JSON.stringify({ email: 'a@b.c', password: 'hunter2' }))
    x.respond(400, { message: 'bad' })
    const e = reqs()[0]!
    expect(e.requestBody).toBeDefined()
    expect(e.requestBody).not.toContain('hunter2')
    expect(e.requestBody).toContain('email')
    expect(x.sentBody).toContain('hunter2') // host body untouched
  })

  it('captures a JSON failure body (redacted) for text and json responseType', () => {
    start('POST', `${API}/a`).respond(422, { message: 'Invalid', token: 'sekret123', errors: { name: ['required'] } })
    const e = reqs()[0]!
    expect(e.responseBody).toContain('Invalid')
    expect(e.responseBody).not.toContain('sekret123')
    expect(e.hasFieldErrors).toBe(true)
    const j = start('POST', `${API}/b`, [], undefined, 'json')
    j.respond(400, { message: 'JSON typed' })
    expect(reqs()[1]!.responseBody).toContain('JSON typed')
    expect(j.responseTextReads).toBe(0) // would throw for responseType json
  })

  it('does not keep a success body', () => {
    start('GET', `${API}/a`).respond(200, { success: true, data: [1] })
    expect(reqs()[0]!.responseBody).toBeUndefined()
  })

  it('never reads blob / arraybuffer responses', () => {
    for (const rt of ['blob', 'arraybuffer'] as const) {
      const x = start('GET', `${API}/file`, [], undefined, rt)
      x.respond(500, 'x')
      expect(x.responseReads).toBe(0)
      expect(x.responseTextReads).toBe(0)
    }
    const es = reqs()
    expect(es.map((e) => e.outcome)).toEqual(['http_error', 'http_error'])
    expect(es.map((e) => e.responseBody)).toEqual(['[not captured]', '[not captured]'])
  })

  it('records abort() as aborted', () => {
    const x = start('GET', `${API}/slow`)
    x.abort()
    expect(reqs()).toHaveLength(1)
    expect(reqs()[0]).toMatchObject({ outcome: 'aborted', status: 0 })
  })

  it('records the timeout event as timeout', () => {
    start('GET', `${API}/slow`).timeoutNow()
    expect(reqs()[0]).toMatchObject({ outcome: 'timeout', status: 0 })
  })

  it('records a network error as network', () => {
    start('GET', `${API}/down`).networkError()
    expect(reqs()[0]).toMatchObject({ outcome: 'network', status: 0 })
  })

  it('status 0 on load counts as network', () => {
    const x = start('GET', `${API}/z`)
    x.status = 0
    ;(x as unknown as { fire: (t: string) => void }).fire('load')
    expect(reqs()[0]!.outcome).toBe('network')
  })

  it('host listeners (addEventListener, onload, onreadystatechange) each fire exactly once and records once', () => {
    const x = new XMLHttpRequest() as unknown as FakeXHR
    const calls = { add: 0, onload: 0, orsc: 0 }
    x.addEventListener('load', () => calls.add++)
    x.onload = () => calls.onload++
    x.onreadystatechange = () => calls.orsc++
    x.open('GET', `${API}/h`)
    x.send()
    x.respond(200, { success: true })
    expect(calls).toEqual({ add: 1, onload: 1, orsc: 1 })
    expect(reqs()).toHaveLength(1)
  })

  it('keeps host semantics: return values and arguments pass through', () => {
    const x = new XMLHttpRequest() as unknown as FakeXHR
    x.open('PUT', `${API}/p`)
    x.send('body')
    expect(x.sentBody).toBe('body')
  })

  it('a reused xhr records each send once, with its own method/url', () => {
    const x = new XMLHttpRequest() as unknown as FakeXHR
    x.open('GET', `${API}/one`)
    x.send()
    x.respond(200, { success: true })
    x.open('POST', `${API}/two`)
    x.send('{}')
    x.respond(500, { message: 'e' })
    const r = reqs()
    expect(r).toHaveLength(2)
    expect([r[0]!.method, r[0]!.url]).toEqual(['GET', `${API}/one`])
    expect([r[1]!.method, r[1]!.url, r[1]!.outcome]).toEqual(['POST', `${API}/two`, 'http_error'])
  })

  it('marks a 401 as refreshed when the same request later succeeds (as fetch does)', () => {
    start('GET', `${API}/me`).respond(401, { message: 'expired' })
    start('GET', `${API}/me`).respond(200, { success: true })
    const [a, b] = reqs()
    expect(a!.status).toBe(401)
    expect(a!.refreshed).toBe(true)
    expect(b!.refreshed).toBeUndefined()
  })

  it('leaves a 401 unrefreshed when no retry succeeds', () => {
    start('GET', `${API}/me`).respond(401, { message: 'expired' })
    start('GET', `${API}/other`).respond(200, { success: true })
    expect(reqs()[0]!.refreshed).toBeUndefined()
  })

  it('restores the prototype methods on reset', () => {
    const proto = FakeXHR.prototype
    const patchedSend = proto.send
    __resetForTests()
    expect(proto.send).not.toBe(patchedSend)
  })
})
