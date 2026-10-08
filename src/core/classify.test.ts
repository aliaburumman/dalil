import { describe, expect, it } from 'vitest'
import { classify } from './classify'
import type { DalilEvent, RequestEvent } from './types'

const NOW = 1_000_000
let n = 0
const req = (over: Partial<RequestEvent>): RequestEvent => ({
  id: `r${++n}`,
  t: NOW - 10_000,
  type: 'request',
  method: 'POST',
  url: 'https://api.thecourtspace.com/Payment/Create?x=1',
  status: 200,
  durationMs: 100,
  outcome: 'ok',
  ...over,
})

describe('classify (Space API fixtures)', () => {
  it('200 {success:false, code:InternalServerError} → backend', () => {
    const e = req({ outcome: 'app_error', appCode: 'InternalServerError' })
    const v = classify([e], NOW)
    expect(v.kind).toBe('backend')
    expect(v.evidenceEventId).toBe(e.id)
    expect(v.headline).toBe('Backend error: InternalServerError on POST /Payment/Create')
  })

  it('400 {success:false, errors:{Amount}} → validation', () => {
    const v = classify([req({ status: 400, outcome: 'http_error', hasFieldErrors: true })], NOW)
    expect(v.kind).toBe('validation')
    expect(v.headline).toBe('Validation error: 400 on POST /Payment/Create')
  })

  it('200 with field errors → validation', () => {
    expect(classify([req({ outcome: 'app_error', hasFieldErrors: true })], NOW).kind).toBe('validation')
  })

  it('500 → backend with path-only headline', () => {
    const v = classify([req({ status: 500, outcome: 'http_error' })], NOW)
    expect(v).toMatchObject({ kind: 'backend', confidence: 'high', headline: 'Backend error: 500 on POST /Payment/Create' })
  })

  it('network reject → network', () => {
    expect(classify([req({ status: 0, outcome: 'network' })], NOW).kind).toBe('network')
    expect(classify([req({ status: 0, outcome: 'timeout' })], NOW).kind).toBe('network')
  })

  it('caller-aborted request is ignored', () => {
    const v = classify([req({ status: 0, outcome: 'aborted' })], NOW)
    expect(v.kind).toBe('ux')
    expect(v.confidence).toBe('low')
  })

  it('401 followed by a successful retry is ignored (flag or inferred)', () => {
    const a = req({ status: 401, outcome: 'http_error', method: 'GET', t: NOW - 5000 })
    const b = req({ status: 200, outcome: 'ok', method: 'GET', t: NOW - 4000 })
    expect(classify([a, b], NOW).kind).toBe('ux')
    expect(classify([{ ...a, refreshed: true }], NOW).kind).toBe('ux')
  })

  it('401 without retry → permission', () => {
    expect(classify([req({ status: 401, outcome: 'http_error' })], NOW).kind).toBe('permission')
  })

  it('JS error → frontend', () => {
    const v = classify([{ id: 'e1', t: NOW - 1000, type: 'error', source: 'window', message: 'x is undefined' }], NOW)
    expect(v.kind).toBe('frontend')
    expect(v.headline).toContain('x is undefined')
  })

  it('zod log → frontend; info log does not count', () => {
    expect(classify([{ id: 'l1', t: NOW - 1000, type: 'log', level: 'warn', message: 'Zod drift in /Players' }], NOW).kind).toBe(
      'frontend',
    )
    expect(classify([{ id: 'l2', t: NOW - 1000, type: 'log', level: 'info', message: 'loaded' }], NOW).kind).toBe('ux')
  })

  it('nothing → ux, low confidence', () => {
    const v = classify([{ id: 'c', t: NOW - 100, type: 'click', label: 'Save', tag: 'button' }], NOW)
    expect(v).toEqual({ kind: 'ux', headline: 'No technical failure seen', confidence: 'low', alsoSeen: [] })
    expect(classify([], NOW).kind).toBe('ux')
  })

  it('most recent failure wins; others are alsoSeen, most recent first', () => {
    const old = req({ status: 500, outcome: 'http_error', t: NOW - 30_000 })
    const err: DalilEvent = { id: 'e2', t: NOW - 20_000, type: 'error', source: 'console', message: 'boom' }
    const latest = req({ status: 400, outcome: 'http_error', t: NOW - 5_000 })
    const v = classify([old, latest, err], NOW)
    expect(v.kind).toBe('validation')
    expect(v.evidenceEventId).toBe(latest.id)
    expect(v.alsoSeen).toEqual([err.id, old.id])
  })

  it('ignores failures older than 90 s when the window has events', () => {
    const old = req({ status: 500, outcome: 'http_error', t: NOW - 200_000 })
    const click: DalilEvent = { id: 'c2', t: NOW - 1000, type: 'click', label: 'Save', tag: 'button' }
    expect(classify([old, click], NOW).kind).toBe('ux')
    // falls back to the whole buffer when the window is empty
    expect(classify([old], NOW).kind).toBe('backend')
  })
})
