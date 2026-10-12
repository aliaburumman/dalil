import { describe, expect, it } from 'vitest'
import { buildShare } from '../../shared/share'
import { scrubSecrets } from '../../shared/scrub'
import { esc, pathOf, truncate } from '../../shared/text'

const base = { ref: 'DL-1', title: 'Save fails', createdAt: Date.UTC(2026, 9, 12, 10, 0), pageUrl: 'https://app.test/a?x=1' }

describe('shared/share', () => {
  it('includes the evidence line when url is given', () => {
    const s = buildShare({ ...base, url: 'https://t.test/r/1' })
    expect(s.html).toContain('Full evidence (screenshot, replay)')
    expect(s.text).toContain('Full evidence: https://t.test/r/1')
  })
  it('omits the evidence line (html + text) without url, rest identical', () => {
    const withUrl = buildShare({ ...base, url: 'https://t.test/r/1' })
    const without = buildShare(base)
    expect(without.html).not.toContain('Full evidence')
    expect(without.text).not.toContain('Full evidence')
    expect(without.html).toBe(withUrl.html.replace(/<p><a href="[^"]*">Full evidence[^<]*<\/a><\/p>$/, ''))
    expect(without.text).toBe(withUrl.text.replace(/\nFull evidence: .*$/, ''))
  })
})

describe('shared/text + scrub', () => {
  it('esc/pathOf/truncate behave', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
    expect(pathOf('https://h.test/p?q=1')).toBe('/p?q=1')
    expect(truncate('a  b   c', 3)).toBe('a …')
  })
  it('scrubSecrets redacts JWT and Bearer', () => {
    const r = scrubSecrets('{"a":"eyJabc.def.ghi","h":"Bearer sk-123"}')
    expect(r.scrubbed).toBe(true)
    expect(r.text).toBe('{"a":"[JWT]","h":"Bearer [REDACTED]"}')
    expect(scrubSecrets('nothing').scrubbed).toBe(false)
  })
})
