import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __flushMirrorForTests, internalInit, __resetForTests, init, log, onEvent, onOpen, open, snapshot } from './recorder'
import type { ClickEvent, DalilConfig, RequestEvent } from './types'

const API = 'https://api.thecourtspace.com'
const cfg: DalilConfig = { project: 'space', publicKey: 'pk', endpoint: 'https://dalil.example.com/v1/reports', apiOrigins: [API] }

type Call = { input: RequestInfo | URL; init?: RequestInit }
let calls: Call[]
let nextResponse: () => Response | Promise<Response>

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const tick = () => new Promise((r) => setTimeout(r, 0))
const requests = () => snapshot().events.filter((e): e is RequestEvent => e.type === 'request')

beforeEach(() => {
  calls = []
  nextResponse = () => json({ success: true })
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return nextResponse()
  }) as unknown as typeof fetch
  document.body.innerHTML = ''
  sessionStorage.clear()
  init(cfg)
})

afterEach(() => {
  __resetForTests()
})

describe('fetch patch', () => {
  it('ignores fetches carrying the internal marker (no event, no X-Request-Id)', async () => {
    await fetch(`${API}/academy/logo.png`, internalInit())
    await tick()
    expect(requests()).toHaveLength(0)
    expect(calls[0]!.init?.headers).toBeUndefined()
    await fetch(`${API}/Players`)
    await tick()
    expect(requests()).toHaveLength(1)
  })

  it('returns the original Response; host can still read json() after capture', async () => {
    const original = json({ success: false, code: 'InternalServerError', token: 'abc' })
    nextResponse = () => original
    const res = await fetch(`${API}/Payment/Create`, { method: 'POST', body: '{"query":{"amount":5}}' })
    expect(res).toBe(original)
    expect(await res.json()).toEqual({ success: false, code: 'InternalServerError', token: 'abc' })
    await tick()
    const [e] = requests()
    expect(e).toMatchObject({ outcome: 'app_error', appCode: 'InternalServerError', status: 200, method: 'POST' })
    expect(e!.responseBody).toContain('"token":"[REDACTED]"')
    expect(e!.requestBody).toBe('{"query":{"amount":5}}')
  })

  it('does not store response bodies for successes', async () => {
    await fetch(`${API}/Players`)
    await tick()
    expect(requests()[0]!.responseBody).toBeUndefined()
    expect(requests()[0]!.outcome).toBe('ok')
  })

  it('records validation errors from a 400', async () => {
    nextResponse = () => json({ success: false, errors: { Amount: ['required'] } }, 400)
    await fetch(`${API}/Payment/Create`, { method: 'POST' })
    await tick()
    expect(requests()[0]).toMatchObject({ outcome: 'http_error', status: 400, hasFieldErrors: true })
    expect(snapshot().verdict.kind).toBe('validation')
  })

  it('skips cloning large or non-JSON bodies', async () => {
    nextResponse = () => new Response('x', { status: 200, headers: { 'content-type': 'text/html' } })
    await fetch(`${API}/a`)
    nextResponse = () => json({ success: false }, 200, { 'content-length': String(70_000) })
    await fetch(`${API}/b`)
    await tick()
    const [a, b] = requests()
    expect(a!.responseBody).toBeUndefined() // 2xx non-JSON is never cloned
    expect(b!.outcome).toBe('ok') // body not read, so success:false cannot be seen
  })

  it('captures a redacted, truncated text/html body of a 502', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def'
    const html = `<html><body>Bad gateway token ${jwt} ${'x'.repeat(20_000)}</body></html>`
    nextResponse = () => new Response(html, { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } })
    await fetch(`${API}/proxy`)
    await tick()
    const body = requests()[0]!.responseBody!
    expect(body).toContain('Bad gateway')
    expect(body).not.toContain(jwt)
    expect(body.length).toBeLessThan(10 * 1024 + 50)
  })

  it('adds X-Request-Id only for apiOrigins, preserving the headers form', async () => {
    const h = new Headers({ Authorization: 'Bearer secret', 'X-Client-Type': 'web' })
    await fetch(`${API}/a`, { headers: h })
    await fetch(`${API}/b`, { headers: { Accept: 'application/json' } })
    await fetch(`${API}/c`, { headers: [['Accept', '*/*']] })
    await fetch(`${API}/d`)
    await fetch('https://third-party.com/x', { headers: { Accept: '*/*' } })
    await tick()

    const [a, b, c, d, third] = calls
    expect(a!.init!.headers).toBeInstanceOf(Headers)
    expect((a!.init!.headers as Headers).get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(h.has('x-request-id')).toBe(false) // host's object untouched
    expect(Object.getPrototypeOf(b!.init!.headers)).toBe(Object.prototype)
    expect((b!.init!.headers as Record<string, string>)['X-Request-Id']).toBeTruthy()
    expect(Array.isArray(c!.init!.headers)).toBe(true)
    expect((c!.init!.headers as string[][]).find(([k]) => k === 'X-Request-Id')).toBeTruthy()
    expect((d!.init!.headers as Record<string, string>)['X-Request-Id']).toBeTruthy()
    expect(third!.init!.headers).toEqual({ Accept: '*/*' })

    const evs = requests()
    expect(evs[0]!.hadAuth).toBe(true)
    expect(evs[0]!.extraHeaders).toEqual({ 'x-client-type': 'web' })
    expect(JSON.stringify(evs)).not.toContain('secret')
    expect(evs[0]!.requestId).toBe((a!.init!.headers as Headers).get('x-request-id'))
    expect(evs[4]!.requestId).toBeUndefined()
  })

  it('handles fetch(Request) and reads its body via clone', async () => {
    nextResponse = () => json({ success: false }, 500)
    const r = new Request(`${API}/Payment/Create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":"x","amount":1}',
    })
    await fetch(r)
    await tick()
    await tick()
    const e = requests()[0]!
    expect(e.requestBody).toBe('{"password":"[REDACTED]","amount":1}')
    expect(e.requestId).toBeTruthy()
    expect((calls[0]!.init!.headers as Headers).get('content-type')).toBe('application/json')
  })

  it('network rejection → network; caller abort → aborted; own timeout → timeout', async () => {
    window.fetch = vi.fn() as unknown as typeof fetch // replaced below via nextResponse
    __resetForTests()
    window.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return nextResponse()
    }) as typeof fetch
    init(cfg)

    nextResponse = () => Promise.reject(new TypeError('Failed to fetch'))
    await expect(fetch(`${API}/a`)).rejects.toThrow('Failed to fetch')

    const ac = new AbortController()
    ac.abort()
    await expect(fetch(`${API}/b`, { signal: ac.signal })).rejects.toThrow()

    nextResponse = () => Promise.reject(new DOMException('timed out', 'AbortError'))
    await expect(fetch(`${API}/c`)).rejects.toThrow()
    await tick()
    expect(requests().map((e) => e.outcome)).toEqual(['network', 'aborted', 'timeout'])
  })

  it('marks a 401 refreshed when the retry succeeds', async () => {
    nextResponse = () => json({ success: false }, 401)
    await fetch(`${API}/Me`)
    nextResponse = () => json({ success: true })
    await fetch(`${API}/Me`)
    await tick()
    expect(requests()[0]!.refreshed).toBe(true)
    expect(snapshot().verdict.kind).toBe('ux')
    expect(Object.keys(snapshot().curls)).toHaveLength(0)
  })

  it('snapshot builds curls for failed requests', async () => {
    nextResponse = () => json({ success: false }, 500)
    await fetch(`${API}/Payment/Create`, { method: 'POST', headers: { Authorization: 'Bearer z' }, body: '{}' })
    await tick()
    const s = snapshot()
    const id = requests()[0]!.id
    expect(s.curls[id]).toContain('"Authorization: Bearer $TOKEN"')
    expect(s.verdict.headline).toBe('Backend error: 500 on POST /Payment/Create')
  })

  it('never records requests to the dalil endpoint', async () => {
    await fetch(cfg.endpoint, { method: 'POST' })
    await tick()
    expect(requests()).toHaveLength(0)
  })
})

describe('DOM capture', () => {
  const clicks = () => snapshot().events.filter((e): e is ClickEvent => e.type === 'click')

  it('resolves click labels in order and finds context', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-label="Add Payment">
        <button id="a" data-dalil-label="Save payment" aria-label="no">x</button>
        <button id="b" aria-label="Close">×</button>
        <button id="c"><span id="inner">  Pay   now  </span></button>
      </div>
      <section><h2>Players</h2><div><div role="tab" id="d"></div></div></section>`
    for (const id of ['a', 'b', 'inner', 'd']) document.getElementById(id)!.click()
    const c = clicks()
    expect(c.map((x) => x.label)).toEqual(['Save payment', 'Close', 'Pay now', 'div[role=tab]'])
    expect(c[0]!.context).toBe('Add Payment')
    expect(c[2]!.tag).toBe('button')
    expect(c[3]!.context).toBe('Players')
  })

  it('truncates long labels to 60 chars', () => {
    document.body.innerHTML = `<button id="x">${'a'.repeat(100)}</button>`
    document.getElementById('x')!.click()
    expect(clicks()[0]!.label.length).toBeLessThanOrEqual(60)
  })

  it('records input field names, never values, and dedupes within 2 s', () => {
    document.body.innerHTML = `<h1>Login</h1><form><label for="p">Password</label><input id="p" type="password">
      <input name="amount" placeholder="Amount"></form>`
    const p = document.getElementById('p') as HTMLInputElement
    const amt = document.querySelector('[name=amount]') as HTMLInputElement
    for (const v of ['h', 'hu', 'hunter2']) {
      p.value = v
      p.dispatchEvent(new Event('input', { bubbles: true }))
    }
    amt.value = '50'
    amt.dispatchEvent(new Event('change', { bubbles: true }))
    const inputs = snapshot().events.filter((e) => e.type === 'input')
    expect(inputs).toEqual([
      expect.objectContaining({ field: 'Password', context: 'Login' }),
      expect.objectContaining({ field: 'amount' }),
    ])
    expect(JSON.stringify(snapshot().events)).not.toContain('hunter2')
    expect(JSON.stringify(snapshot().events)).not.toContain('"50"')
  })

  it('ignores anything inside [data-dalil-ignore]', () => {
    document.body.innerHTML = `<div data-dalil-ignore><button id="w">Report bug</button><input id="t"></div>`
    document.getElementById('w')!.click()
    document.getElementById('t')!.dispatchEvent(new Event('input', { bubbles: true }))
    expect(snapshot().events.filter((e) => e.type === 'click' || e.type === 'input')).toHaveLength(0)
  })

  it('records submits by form label', () => {
    document.body.innerHTML = `<form aria-label="Add player"><button type="submit" id="s">Go</button></form>`
    const f = document.querySelector('form')!
    f.addEventListener('submit', (e) => e.preventDefault())
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(snapshot().events.some((e) => e.type === 'submit' && e.form === 'Add player')).toBe(true)
  })
})

describe('history, errors, log, emitter', () => {
  it('records navigation with redacted query and no hash', () => {
    history.pushState({}, '', '/players?token=abc&page=2#x')
    const nav = snapshot().events.filter((e) => e.type === 'nav')
    expect(nav.at(-1)).toMatchObject({ url: '/players?token=[REDACTED]&page=2' })
  })

  it('wraps console.error and redacts it', () => {
    const spy = vi.fn()
    __resetForTests()
    const orig = console.error
    console.error = spy
    init(cfg)
    console.error('failed with Bearer abc123')
    expect(spy).toHaveBeenCalledWith('failed with Bearer abc123')
    const err = snapshot().events.find((e) => e.type === 'error')
    expect(err).toMatchObject({ source: 'console', message: 'failed with Bearer [REDACTED]' })
    __resetForTests()
    expect(console.error).toBe(spy)
    console.error = orig
  })

  it('log() redacts data and caps it', () => {
    log('Zod drift', { password: 'x', n: 1 }, 'warn')
    const l = snapshot().events.find((e) => e.type === 'log')
    expect(l).toMatchObject({ level: 'warn', message: 'Zod drift', data: '{"password":"[REDACTED]","n":1}' })
    expect(snapshot().verdict.kind).toBe('frontend')
  })

  it('open()/onOpen emitter', () => {
    const cb = vi.fn()
    const off = onOpen(cb)
    open()
    off()
    open()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('init is idempotent and reset restores fetch', () => {
    const patched = window.fetch
    init(cfg)
    expect(window.fetch).toBe(patched)
    __resetForTests()
    expect(window.fetch).not.toBe(patched)
  })
})

describe('sessionStorage mirror', () => {
  it('holds summaries only (no bodies) and is restored on init', async () => {
    nextResponse = () => json({ success: false, message: 'secret-response-body' }, 500)
    await fetch(`${API}/Payment/Create`, { method: 'POST', body: '{"note":"secret-request-body"}' })
    log('hello', { note: 'secret-log-data' })
    await tick()
    __flushMirrorForTests()
    const raw = sessionStorage.getItem('dalil:events')!
    expect(raw).toContain('/Payment/Create')
    expect(raw).not.toContain('secret-response-body')
    expect(raw).not.toContain('secret-request-body')
    expect(raw).not.toContain('secret-log-data')

    // simulate a reload: drop in-memory state, keep storage
    __resetForTests()
    sessionStorage.setItem('dalil:events', raw)
    init(cfg)
    const restored = requests()
    expect(restored).toHaveLength(1)
    expect(restored[0]!.status).toBe(500)
    expect(snapshot().verdict.kind).toBe('backend')
  })
})

describe('onEvent', () => {
  it('notifies subscribers of each recorded event and stops after unsubscribe', async () => {
    const seen: string[] = []
    const off = onEvent((e) => seen.push(e.type))
    log('hello', undefined, 'error')
    await fetch(`${API}/Players`)
    await tick()
    expect(seen).toContain('log')
    expect(seen).toContain('request')
    off()
    const n = seen.length
    log('again')
    expect(seen.length).toBe(n)
  })

  it('a throwing listener never breaks recording', () => {
    onEvent(() => {
      throw new Error('boom')
    })
    log('still recorded')
    expect(snapshot().events.some((e) => e.type === 'log' && e.message === 'still recorded')).toBe(true)
  })
})
