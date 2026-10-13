// Real-browser end-to-end test of dalil/next in two production Next apps:
//   examples/next-app    (App Router, strict CSP: style-src 'self')
//   examples/next-pages  (Pages Router)
// Collector and dev.azure.com are emulated, so no network and no real org/PAT is needed.
// Prereqs: `npm ci`, `npm run build` (root), `npx playwright install chromium`; example deps are installed on demand.
// Run: node scripts/e2e-next.mjs [--app next-app|next-pages]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COLLECTOR_PORT = Number(process.env.COLLECTOR_PORT ?? 4410)
const COLLECTOR = `http://localhost:${COLLECTOR_PORT}`
const APPS = { 'next-app': { port: 4411, csp: true, ado: true }, 'next-pages': { port: 4412, csp: false, ado: false } }
const argIdx = process.argv.indexOf('--app')
const only = argIdx > 0 ? process.argv[argIdx + 1] : null
if (only && !APPS[only]) (console.log(`FAIL unknown app ${only}`), process.exit(1))

let failed = 0
let prefix = ''
const check = (n, ok, x = '') => (console.log(`${ok ? 'PASS' : 'FAIL'} ${prefix}${n}${x ? ' :: ' + x : ''}`), ok || failed++)

if (!fs.existsSync(path.join(repo, 'dist', 'next', 'index.js'))) {
  console.log('FAIL dist/next missing: run `npm run build` in the repo root')
  process.exit(1)
}

// ---- mock collector ----
const reports = []
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
const collector = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
  if (req.method === 'POST' && req.url.startsWith('/v1/reports')) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1')
      const parts = [...raw.matchAll(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:[^\r\n]+\r\n)*\r\n/g)]
      const names = parts.map((m) => m[1])
      const rm = /name="report"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)
      let report = null
      try { report = JSON.parse(Buffer.from(rm[1], 'latin1').toString('utf8')) } catch { /* keep null */ }
      reports.push({ names, report, key: req.headers['x-dalil-key'] })
      res.writeHead(201, { ...cors, 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'r1', ref: 'T-1', url: 'https://example.test/r/1', share: { title: 'T-1', html: '<b>T-1</b>', text: 'T-1' } }))
    })
    return
  }
  res.writeHead(404, cors).end()
})

// ---- Azure DevOps emulation (as in e2e-ado.mjs) ----
const ado = { uploads: [], patches: [], typesCalls: 0, n: 0 }
const patOf = (req) => {
  const raw = Buffer.from((req.headers()['authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString('utf8')
  return raw.slice(raw.indexOf(':') + 1)
}
async function adoRoute(route) {
  const req = route.request()
  const origin = req.headers()['origin'] ?? '*'
  const h = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
  const j = (status, body) => ({ status, headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const url = new URL(req.url())
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  if (!patOf(req).startsWith('good')) return route.fulfill(j(401, { message: 'unauthorized' }))
  const p = url.pathname
  if (req.method() === 'GET' && p.endsWith('/_apis/wit/workitemtypes')) {
    ado.typesCalls++
    return route.fulfill(j(200, { value: [{ name: 'Bug' }, { name: 'Task' }] }))
  }
  if (req.method() === 'POST' && p.endsWith('/_apis/wit/attachments')) {
    const n = ++ado.n
    ado.uploads.push({ fileName: url.searchParams.get('fileName'), body: req.postDataBuffer() ?? Buffer.alloc(0) })
    return route.fulfill(j(201, { id: String(n), url: `https://dev.azure.com/o/_apis/wit/attachments/${n}` }))
  }
  if (req.method() === 'POST' && p.includes('/_apis/wit/workitems/')) {
    ado.patches.push({ path: p, body: req.postData() ?? '' })
    return route.fulfill(j(200, { id: 4242, _links: { html: { href: 'https://dev.azure.com/o/p/_workitems/edit/4242' } } }))
  }
  return route.fulfill(j(404, {}))
}

function run(cmd, args, cwd, env) {
  const t = Date.now()
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
  return { ok: r.status === 0, secs: ((Date.now() - t) / 1000).toFixed(1), out: (r.stdout ?? '') + (r.stderr ?? '') }
}

async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return true } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function testApp(name, cfg, browser) {
  prefix = `[${name}] `
  const dir = path.join(repo, 'examples', name)
  const env = { NEXT_PUBLIC_DALIL_ENDPOINT: `${COLLECTOR}/v1/reports`, NEXT_TELEMETRY_DISABLED: '1' }
  if (!fs.existsSync(path.join(dir, 'node_modules', 'next'))) {
    const i = run('npm', ['install', '--no-audit', '--no-fund'], dir, env)
    if (!i.ok) return check('npm install', false, i.out.slice(-400))
  }
  const b = run('npx', ['next', 'build'], dir, env)
  check(`next build (${b.secs}s)`, b.ok, b.ok ? '' : b.out.slice(-600))
  if (!b.ok) return
  const srv = spawn('npx', ['next', 'start', '-p', String(cfg.port)], { cwd: dir, env: { ...process.env, ...env }, stdio: 'ignore' })
  const BASE = `http://localhost:${cfg.port}`
  try {
    if (!(await waitHttp(BASE + '/'))) return check('next start reachable', false)

    const html = await (await fetch(BASE + '/')).text()
    check("raw HTML of '/' has no dalil host", !/dalil-root/i.test(html))

    const ctx = await browser.newContext()
    await ctx.route('https://dev.azure.com/**', adoRoute)
    await ctx.addInitScript(() => {
      window.__csp = []
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
    })
    const pg = await ctx.newPage()
    const errors = []
    pg.on('pageerror', (e) => errors.push('pageerror: ' + e))
    pg.on('console', (m) => {
      if (m.type() !== 'error' && !(m.type() === 'warning' && /hydrat/i.test(m.text()))) return
      if (/Failed to load resource.*(500)/.test(m.text())) return // the deliberate failing fetch
      errors.push(m.text())
    })
    const sh = (sel) => pg.locator(`dalil-root >> ${sel}`)
    const ready = () => pg.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'), null, { timeout: 20000 })
    const gone = () => pg.waitForFunction(() => !document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'))

    // ---- collector flow ----
    await pg.goto(BASE + '/')
    await ready()
    check('widget button appears', true)
    await pg.click('#to-second')
    await pg.waitForSelector('#second-title')
    check('client-side Link navigation (no full reload)', await pg.evaluate(() => performance.getEntriesByType('navigation').length === 1 && location.pathname === '/second'))
    await pg.goBack()
    await pg.waitForSelector('#save')
    await pg.click('#to-second')
    await pg.waitForSelector('#second-title')
    await pg.click('a[href="/"]')
    await pg.waitForSelector('#save')
    await pg.click('#save')
    await pg.waitForFunction(() => document.getElementById('out').textContent.includes('500'))
    await pg.click('#toast')
    await pg.waitForTimeout(1500) // auto-snap of the toast
    const style = (sel) => pg.evaluate((q) => {
      const el = document.querySelector('dalil-root').shadowRoot.querySelector(q)
      if (!el) return null
      const c = getComputedStyle(el)
      return { bg: c.backgroundColor, radius: c.borderRadius, pad: c.padding }
    }, sel)
    const fab = cfg.csp ? await style('.dalil-fab') : null
    await pg.keyboard.press('Control+Shift+B')
    await sh('textarea.dalil-textarea').first().waitFor({ timeout: 20000 })
    if (cfg.csp) {
      const dlg = await style('.dalil-dialog')
      check('dialog styles applied under style-src self', !!dlg && dlg.bg !== 'rgba(0, 0, 0, 0)' && dlg.radius === '10px' && dlg.pad === '16px', JSON.stringify(dlg))
      check('fab styles applied', !!fab && fab.bg !== 'rgba(0, 0, 0, 0)' && fab.radius !== '0px', JSON.stringify(fab))
    }
    await sh('textarea.dalil-textarea').first().fill('Save fails with 500')
    await sh('.dalil-actions .dalil-primary').click()
    await sh('.dalil-sent').waitFor({ timeout: 30000 })
    const rep = reports[reports.length - 1]
    check('collector received a report', !!rep?.report, JSON.stringify(rep?.names))
    check('report has >=1 image part', (rep?.names ?? []).some((n) => /^(image|auto)_\d+$/.test(n)), (rep?.names ?? []).join(','))
    const ev = rep?.report?.events ?? []
    const navs = ev.filter((e) => e.type === 'nav')
    check('Link navigation to /second recorded in events', navs.some((e) => JSON.stringify(e).includes('/second')), JSON.stringify(navs.map((e) => e.to ?? e.url ?? e.path)))
    const failing = ev.find((e) => e.type === 'request' && e.status === 500 && e.url.includes('/api/fail'))
    check('failing fetch captured in events', !!failing)
    check('verdict names the backend 500', /Backend error: 500 on POST \/api\/fail/.test(rep?.report?.verdict?.headline ?? ''), rep?.report?.verdict?.headline)
    check('toast captured', ev.some((e) => e.source === 'toast') || !!rep?.report?.verdict?.userSaw)
    await sh('.dalil-sent .dalil-btn.dalil-primary').click()
    await gone()

    // ---- Azure DevOps flow ----
    if (cfg.ado) {
      await pg.goto(BASE + '/?ado=1')
      await ready()
      await pg.click('#save')
      await pg.waitForFunction(() => document.getElementById('out').textContent.includes('500'))
      await pg.waitForTimeout(1200)
      await pg.keyboard.press('Control+Shift+B')
      await sh('input[type=password]').first().waitFor({ timeout: 20000 })
      check('ADO: Connect view appears', true)
      await sh('input[type=password]').fill('good-x')
      await sh('.dalil-actions .dalil-primary').click()
      await sh('textarea.dalil-textarea').first().waitFor({ timeout: 20000 })
      await sh('textarea.dalil-textarea').first().fill('ado save fails')
      await sh('.dalil-actions .dalil-primary').click()
      await sh('.dalil-sent').waitFor({ timeout: 30000 })
      check('ADO: work item create called', ado.patches.length >= 1 && /\$Bug$/.test(ado.patches[ado.patches.length - 1].path))
      const replay = ado.uploads.find((u) => /^replay-.*\.html$/.test(u.fileName ?? ''))
      check('ADO: replay-*.html upload contains rrwebPlayer', !!replay && replay.body.toString('utf8').includes('rrwebPlayer'), ado.uploads.map((u) => u.fileName).join(','))
    }

    const csp = await pg.evaluate(() => window.__csp)
    if (cfg.csp) check('no CSP violation events', csp.length === 0, csp.join(' | '))
    check('no console errors / hydration warnings / page errors', errors.length === 0, errors.join(' | ').slice(0, 600))
    await ctx.close()
  } finally {
    srv.kill('SIGTERM')
    spawnSync('pkill', ['-f', `next start -p ${cfg.port}`])
  }
}

async function main() {
  await new Promise((r, rej) => (collector.once('error', rej), collector.listen(COLLECTOR_PORT, r)))
  const browser = await chromium.launch()
  for (const [name, cfg] of Object.entries(APPS)) {
    if (only && only !== name) continue
    await testApp(name, cfg, browser)
  }
  await browser.close()
}

try {
  await main()
} catch (e) {
  console.log(`FAIL ${String(e?.stack ?? e)}`)
  failed++
}
collector.close()
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
