import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOrTimeout, resolveConfig, startOnFirst } from './start'

afterEach(() => vi.useRealTimers())

describe('startOnFirst', () => {
  it('starts once on the first signal and cleans up the others', () => {
    const start = vi.fn()
    const cleaned: string[] = []
    let fireB: () => void = () => {}
    startOnFirst(start, [
      (fire) => {
        fire()
        return () => cleaned.push('a')
      },
      (fire) => {
        fireB = fire
        return () => cleaned.push('b')
      },
    ])
    fireB()
    expect(start).toHaveBeenCalledTimes(1)
    expect(cleaned).toEqual(['a'])
  })

  it('a later signal wins when earlier ones never fire; stop() cancels', () => {
    const start = vi.fn()
    let fire2: () => void = () => {}
    const stop = startOnFirst(start, [() => {}, (f) => void (fire2 = f)])
    stop()
    fire2()
    expect(start).not.toHaveBeenCalled()
    let fire3: () => void = () => {}
    startOnFirst(start, [(f) => void (fire3 = f)])
    fire3()
    fire3()
    expect(start).toHaveBeenCalledTimes(1)
  })
})

describe('loadOrTimeout', () => {
  it('fires 5 s after window load (or now+5s when already loaded)', () => {
    vi.useFakeTimers()
    const start = vi.fn()
    startOnFirst(start, [loadOrTimeout(5000)])
    vi.advanceTimersByTime(4999)
    expect(start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(start).toHaveBeenCalledTimes(1)
  })
})

describe('resolveConfig', () => {
  it('returns a plain object as is and calls a factory', () => {
    const c = { project: 'p' }
    expect(resolveConfig(c)).toBe(c)
    expect(resolveConfig(() => ({ project: 'q' }))).toEqual({ project: 'q' })
  })
})
