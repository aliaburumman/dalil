import { describe, expect, it } from 'vitest'
import { toCurl } from './curl'
import type { RequestEvent } from './types'

// no @types/node in this package: import untyped
const { execFileSync } = (await import(/* @vite-ignore */ 'node:child_process' as string)) as {
  execFileSync: (cmd: string, args: string[]) => { toString(enc: string): string }
}

const base = (over: Partial<RequestEvent> = {}): RequestEvent => ({
  id: '1',
  t: 0,
  type: 'request',
  method: 'POST',
  url: 'https://api.thecourtspace.com/Payment/Create',
  status: 500,
  durationMs: 10,
  outcome: 'http_error',
  ...over,
})

/** Run the curl line through a real shell with `curl` replaced by printf to see the argv. */
function argv(cmd: string): string[] {
  const script = `curl() { for a in "$@"; do printf '%s\\0' "$a"; done; }\nTOKEN=tok123\n${cmd}`
  const out = execFileSync('sh', ['-c', script]).toString('utf8')
  return out.split('\0').slice(0, -1)
}

describe('toCurl', () => {
  it('builds the design example', () => {
    const c = toCurl(
      base({
        hadAuth: true,
        requestContentType: 'application/json',
        requestId: '3f2c',
        extraHeaders: { 'X-Client-Type': 'web' },
        requestBody: '{"query":{"amount":50}}',
      }),
    )
    expect(c).toBe(
      [
        `curl -X POST 'https://api.thecourtspace.com/Payment/Create' \\`,
        `  -H "Authorization: Bearer $TOKEN" \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -H 'X-Request-Id: 3f2c' \\`,
        `  -H 'X-Client-Type: web' \\`,
        `  --data-raw '{"query":{"amount":50}}'`,
      ].join('\n'),
    )
  })

  it('escapes single quotes, keeps newlines and Arabic text intact through a shell', () => {
    const body = `{"note":"it's \\"fine\\"\nسطر جديد","name":"علي's"}`
    const c = toCurl(base({ hadAuth: true, requestBody: body, requestContentType: 'application/json' }))
    expect(c).toContain(`'\\''`)
    const args = argv(c)
    expect(args).toContain('Authorization: Bearer tok123')
    expect(args[args.indexOf('--data-raw') + 1]).toBe(body)
  })

  it('GET has no --data-raw and no -X', () => {
    const c = toCurl(base({ method: 'GET', requestBody: '{"a":1}', url: 'https://x.com/a?b=1' }))
    expect(c).not.toContain('--data-raw')
    expect(c.startsWith(`curl 'https://x.com/a?b=1'`)).toBe(true)
  })

  it('no auth header when hadAuth is false', () => {
    expect(toCurl(base())).not.toContain('Authorization')
  })

  it('multipart becomes a leading comment and the command still parses', () => {
    const c = toCurl(
      base({
        requestContentType: 'multipart/form-data',
        requestBody: '[multipart] amount, receipt=[file: receipt.jpg, 214 KB]',
      }),
    )
    expect(c.split('\n')[0]).toBe('# multipart body not reproduced: amount, receipt=[file: receipt.jpg, 214 KB]')
    expect(c).not.toContain('--data-raw')
    expect(c).not.toContain('Content-Type')
    expect(argv(c)[0]).toBe('-X')
  })
})
