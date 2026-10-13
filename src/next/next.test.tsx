import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('../web', () => ({
  init: vi.fn((c: { project: string }) => calls.push(`init:${c.project}`)),
  update: vi.fn(() => calls.push('update')),
  destroy: vi.fn(() => calls.push('destroy')),
}))
import { DalilClient } from './index'

afterEach(() => {
  calls.length = 0
})

describe('DalilClient', () => {
  it('inits on mount, updates on enabled change, destroys on unmount, renders nothing', () => {
    const { container, rerender, unmount } = render(<DalilClient config={{ project: 'p', enabled: true }} />)
    expect(container.innerHTML).toBe('')
    expect(calls[0]).toBe('init:p')
    rerender(<DalilClient config={{ project: 'p', enabled: false }} />)
    expect(calls.filter((c) => c === 'update').length).toBeGreaterThanOrEqual(2)
    unmount()
    expect(calls.at(-1)).toBe('destroy')
  })
})
