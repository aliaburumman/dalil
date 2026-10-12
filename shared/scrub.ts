// Server-side second line of defence (design §3 "Defence in depth"). The client already
// redacts; anything found here means the client missed it, so the report is flagged
// scrubbed=1 but never rejected. Runs over the raw JSON text; the replacements never
// contain or consume `"` or `\`, so the JSON stays valid.

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g
// "Bearer <anything>" except the curl placeholder $TOKEN and already-redacted markers.
const BEARER = /\bBearer\s+(?!\$TOKEN\b|\[REDACTED\]|\[JWT\])[^\s"\\]+/gi

export function scrubSecrets(text: string): { text: string; scrubbed: boolean } {
  let scrubbed = false
  let out = text.replace(JWT, () => {
    scrubbed = true
    return '[JWT]'
  })
  out = out.replace(BEARER, () => {
    scrubbed = true
    return 'Bearer [REDACTED]'
  })
  return { text: out, scrubbed }
}
