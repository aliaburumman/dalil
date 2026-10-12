// Real-browser end-to-end test: both copy flows must put text/html AND text/plain on the clipboard.
//   A. widget Sent panel "Copy report"   B. collector triage page "Copy repro steps" / "Copy title"
// Prereqs: `npm ci` (root; playwright is a devDependency), `npm run build` (dist/dalil.global.js),
//   `npm ci` in worker/, and a Chromium: `npx playwright install chromium`.
// Run: npm run e2e:copy   (uses ports 8787 for wrangler dev and 4202 for the static page; override
//   with COLLECTOR_PORT / WEB_PORT). Starts `wrangler dev --local` with DEV_NO_AUTH=1 (localhost only),
//   applies local D1 migrations and seeds a project. Local state lives in a temp dir, not worker/.wrangler.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = path.join(repo, 'worker')
const COLLECTOR_PORT = Number(process.env.COLLECTOR_PORT ?? 8787)
const WEB_PORT = Number(process.env.WEB_PORT ?? 4202)
const COLLECTOR = `http://localhost:${COLLECTOR_PORT}`
const WEB = `http://localhost:${WEB_PORT}`
const PROJECT = 'demo'
const KEY = 'pk_demo'
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'dalil-e2e-'))

let failed = 0
const check = (n, ok, x = '') => (console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' :: ' + x : ''}`), ok || failed++)

// ---- static server: repo files + generated test page + a failing API ----
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>copy e2e</title></head><body>
<button id="fail">fail</button><pre id="out"></pre>
<script src="/dist/dalil.global.js"></script>
<script>
Dalil.init({ project: '${PROJECT}', publicKey: '${KEY}', endpoint: '${COLLECTOR}/v1/reports', apiOrigins: [location.origin], enabled: true })
document.getElementById('fail').onclick = () => fetch('/api/fail').then((r) => (document.getElementById('out').textContent = 'fetch -> ' + r.status))
</script></body></html>`
const web = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page)
  if (p === '/api/fail') return res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}')
  const f = path.join(repo, p)
  if (!f.startsWith(repo) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' })
  fs.createReadStream(f).pipe(res)
})

// ---- wrangler ----
const wr = (args) => spawnSync('npx', ['wrangler', ...args], { cwd: workerDir, encoding: 'utf8' })
let wrangler
let wranglerLog = ''
async function cleanup() {
  web.close()
  if (wrangler && wrangler.exitCode === null) {
    wrangler.kill('SIGTERM')
    await new Promise((r) => (wrangler.once('exit', r), setTimeout(r, 4000)))
    if (wrangler.exitCode === null) wrangler.kill('SIGKILL')
  }
  fs.rmSync(persist, { recursive: true, force: true })
}
async function fail(msg) {
  console.log(`FAIL ${msg}`)
  if (wranglerLog) console.log('--- wrangler log tail ---\n' + wranglerLog.split('\n').slice(-25).join('\n'))
  await cleanup()
  process.exit(1)
}

try {
  await new Promise((r, j) => (web.once('error', j), web.listen(WEB_PORT, r)))

  const mig = wr(['d1', 'migrations', 'apply', 'dalil', '--local', '--persist-to', persist])
  if (mig.status !== 0) await fail('d1 migrations apply: ' + (mig.stdout + mig.stderr).slice(-800))
  const sql = `INSERT INTO projects (id, name, public_key, allowed_origins, notify_emails, key_prefix, created_at) VALUES ('${PROJECT}', 'Demo', '${KEY}', '["${WEB}"]', '[]', 'DEMO', unixepoch() * 1000);`
  const seed = wr(['d1', 'execute', 'dalil', '--local', '--persist-to', persist, '--command', sql])
  if (seed.status !== 0) await fail('d1 seed: ' + (seed.stdout + seed.stderr).slice(-800))

  wrangler = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(COLLECTOR_PORT), '--persist-to', persist,
     // wrangler.jsonc has a custom-domain route; without this req.url's host is that domain, not localhost,
     // and DEV_NO_AUTH (localhost-only) would not apply.
     '--local-upstream', `localhost:${COLLECTOR_PORT}`,
     '--var', 'DEV_NO_AUTH:1', '--var', `PUBLIC_BASE:${COLLECTOR}`],
    { cwd: workerDir, env: { ...process.env, CI: '1' } },
  )
  for (const s of [wrangler.stdout, wrangler.stderr]) s.on('data', (d) => (wranglerLog += d))
  const t0 = Date.now()
  for (;;) {
    if (wrangler.exitCode !== null) await fail('wrangler dev exited early')
    if (Date.now() - t0 > 90000) await fail('wrangler dev not ready after 90s')
    try {
      const r = await fetch(`${COLLECTOR}/v1/reports`, { method: 'OPTIONS', headers: { Origin: WEB, 'Access-Control-Request-Method': 'POST' } })
      if (r.status < 500) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  check('collector is up', true)

  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: COLLECTOR })
  const pg = await ctx.newPage()
  const readClip = () =>
    pg.evaluate(async () => {
      const items = await navigator.clipboard.read()
      const out = []
      for (const it of items) {
        const o = { types: [...it.types] }
        for (const t of ['text/html', 'text/plain']) if (it.types.includes(t)) o[t] = await (await it.getType(t)).text()
        out.push(o)
      }
      return out
    })

  // ---- Flow A: widget Sent panel ----
  await pg.goto(WEB + '/')
  const sh = (sel) => pg.locator(`dalil-root >> ${sel}`)
  await pg.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'))
  await pg.click('#fail')
  await pg.waitForFunction(() => document.getElementById('out').textContent.includes('500'))
  await pg.waitForTimeout(500)
  await pg.keyboard.press('Control+Shift+B')
  await pg.waitForFunction(() => document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'), null, { timeout: 15000 })
  const title = 'فشل الحفظ *bold* _it_ `x`'
  await sh('textarea.dalil-textarea').first().fill(title)
  await sh('.dalil-actions .dalil-primary').click()
  await sh('.dalil-sent').waitFor({ timeout: 20000 })
  check('Sent panel shown after submit', true)
  await sh('.dalil-sent .dalil-actions .dalil-btn').first().click()
  await sh('.dalil-sent .dalil-status').filter({ hasText: /\S/ }).waitFor({ timeout: 5000 })
  let clip = await readClip()
  const it = clip.find((c) => c.types.includes('text/html') && c.types.includes('text/plain'))
  check('A: one clipboard item has text/html and text/plain', !!it, JSON.stringify(clip.map((c) => c.types)))
  const ref = /DEMO-\d+/.exec(it?.['text/plain'] ?? '')?.[0]
  check('A: html is rich (<ol> or <p><b>) and has the ref', !!it && /<ol|<p><b>/.test(it['text/html']) && !!ref && it['text/html'].includes(ref), ref)
  check('A: text starts with * and links full evidence', !!it && it['text/plain'].startsWith('*') && it['text/plain'].includes(`Full evidence: ${COLLECTOR}/r/`))
  const url = /Full evidence: (\S+)/.exec(it?.['text/plain'] ?? '')?.[1]
  if (!url) await fail('no triage url in copied text')

  // ---- Flow B: triage page ----
  const resp = await pg.goto(url)
  check('B: triage page reachable (DEV_NO_AUTH)', resp.status() === 200, String(resp.status()))
  await pg.locator('button[data-copy-rich]').click()
  await pg.waitForTimeout(500)
  clip = await readClip()
  const rich = clip.find((c) => c.types.includes('text/html') && c.types.includes('text/plain'))
  check('B: Copy repro steps puts text/html and text/plain', !!rich, JSON.stringify(clip.map((c) => c.types)))
  check('B: repro html has the ref', !!rich && !!ref && rich['text/html'].includes(ref))
  await pg.locator('button[data-copy="share-title"]').click()
  await pg.waitForTimeout(500)
  const copied = await pg.evaluate(() => navigator.clipboard.readText())
  check('B: Copy title equals ref-prefixed title', copied === `${ref}: ${title}`, JSON.stringify(copied))

  // ---- Flow C: jump-to-failure replay (?play=failure) ----
  // The report was submitted with the replay recorder on (default), so the page has a player box.
  const base = url.split('?')[0]
  check('C: copied evidence link carries ?play=failure (report has a replay)', url.endsWith('?play=failure'), url)
  await pg.goto(base + '?play=failure')
  await pg.waitForSelector('#replay-box', { timeout: 15000 })
  const playedFrom = await pg
    .waitForFunction(() => document.getElementById('replay-box')?.getAttribute('data-played-from'), null, { timeout: 30000 })
    .then((h) => h.jsonValue(), () => null)
  const from = Number(playedFrom)
  // 0 when the failure is within the first 5 s of the recording (clamped), otherwise the offset before it; never negative.
  check('C: player seeked via play=failure (data-played-from set, >= 0)', playedFrom !== null && Number.isFinite(from) && from >= 0, String(playedFrom))
  const evidence = await pg.locator('#replay-box').getAttribute('data-evidence')
  check('C: player box carries the verdict evidence event id', !!evidence, String(evidence))
  await pg.goto(base)
  await pg.waitForSelector('#replay-box', { timeout: 15000 })
  await pg.waitForTimeout(1500)
  check('C: plain report link does not auto-seek', (await pg.locator('#replay-box').getAttribute('data-played-from')) === null)

  await browser.close()
} catch (e) {
  await fail(String(e?.stack ?? e))
}
await cleanup()
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
