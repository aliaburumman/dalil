// Mimics the browser against a local `wrangler dev` collector (see worker/README.md).
// Usage: node scripts/e2e-submit.mjs   (BASE, PROJECT, KEY, ORIGIN overridable via env)
import assert from 'node:assert/strict'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const PROJECT = process.env.PROJECT ?? 'demo'
const KEY = process.env.KEY ?? 'pk_demo'
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173'
const TITLE = process.env.TITLE ?? `<script>alert("x")</script> broken & sad`
const endpoint = `${BASE}/v1/reports?project=${PROJECT}`

// 1. Preflight: header names only, no values.
const pre = await fetch(endpoint, {
  method: 'OPTIONS',
  headers: {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-dalil-key,x-dalil-project',
  },
})
console.log('preflight', pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers'))
assert.equal(pre.status, 204)
assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN)

// 2. POST multipart: report JSON + one tiny JPEG.
const payload = {
  v: 1,
  project: PROJECT,
  title: TITLE,
  severity: 'annoying',
  verdict: { kind: 'unknown', headline: 'No clear cause', confidence: 'low', alsoSeen: [] },
  context: {},
  env: { url: `${ORIGIN}/`, userAgent: 'e2e', language: 'en', timezone: 'UTC', viewport: { w: 1, h: 1, dpr: 1 }, online: true },
  events: [],
  curls: {},
  images: [{ part: 'image_0', kind: 'attachment', name: 'a.jpg' }],
}
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
const fd = new FormData()
fd.append('report', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'report.json')
fd.append('image_0', new Blob([jpeg], { type: 'image/jpeg' }), 'a.jpg')
const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'X-Dalil-Project': PROJECT, 'X-Dalil-Key': KEY, Origin: ORIGIN },
  body: fd,
})
const body = await res.json()
console.log('POST', res.status, JSON.stringify(body))
assert.equal(res.status, 201) // collector answers 201 Created
assert.equal(body.ref, 'DEMO-1')

// 3. Triage page (the returned url uses PUBLIC_BASE, so rebuild it against BASE).
const pageUrl = `${BASE}/r/${body.id}`
const page = await fetch(pageUrl)
const html = await page.text()
console.log('GET', pageUrl, page.status)
assert.equal(page.status, 200)
assert.ok(!html.includes(TITLE), 'raw title must not appear unescaped')
assert.ok(html.includes('&lt;script&gt;alert(') , 'escaped title must appear')
console.log('OK: escaped title present, raw title absent')
