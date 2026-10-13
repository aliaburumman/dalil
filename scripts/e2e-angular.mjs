// Real-browser e2e for the Angular example apps (dalil/angular -> provideDalil).
//   examples/angular-ssr       Angular latest, standalone, SSR + hydration, HttpClient withFetch
//   examples/angular-ngmodule  Angular 16, NgModule, webpack browser builder, HttpClientModule (XHR); built with Node 18
//   examples/angular-zoneless  Angular latest, provideZonelessChangeDetection(), no zone.js, withFetch
// Each app is built (unless --no-build), served, and driven in Chromium against an in-process mock collector
// (collector mode) and an emulated dev.azure.com (?ado=1, Azure DevOps mode).
// Prereqs: `npm ci && npm run build` in the repo root, `npx playwright install chromium`.
// Run: node scripts/e2e-angular.mjs [--app angular-ssr|angular-ngmodule|angular-zoneless] [--no-build]
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')
const only = args.includes('--app') ? args[args.indexOf('--app') + 1] : null

// Angular 16's CLI needs Node 18, so that app is built with a pinned Node 18 from npm (the e2e itself runs on the current Node).
const NG16_BUILD = 'npx -y -p node@18 node node_modules/@angular/cli/bin/ng.js build'
const APPS = [
  { name: 'angular-ssr', kind: 'ssr', build: 'npx ng build --configuration development', out: 'dist/angular-ssr/browser', transport: 'fetch', title: 'Dalil, Angular SSR' },
  { name: 'angular-ngmodule', kind: 'static', build: NG16_BUILD, out: 'dist/dalil-angular-ngmodule-example', transport: 'xhr', title: 'Dalil, Angular NgModule' },
  { name: 'angular-zoneless', kind: 'static', build: 'npx ng build', out: 'dist/dalil-angular-zoneless-example/browser', transport: 'fetch', title: 'Dalil, Angular zoneless' },
].filter((a) => !only || a.name === only)
if (!APPS.length) {
  console.log(`FAIL unknown --app ${only}`)
  process.exit(1)
}

let failed = 0
let prefix = ''
const check = (n, ok, x = '') => (console.log(`${ok ? 'PASS' : 'FAIL'} ${prefix}${n}${x ? ' :: ' + String(x).slice(0, 300) : ''}`), ok || failed++)

if (!fs.existsSync(path.join(repo, 'dist', 'angular', 'index.js'))) {
  console.log('FAIL dist/angular missing: run `npm run build` in the repo root first')
  process.exit(1)
}

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer()
    s.once('error', rej)
    s.listen(0, () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
const listen = (srv, port = 0) => new Promise((res, rej) => (srv.once('error', rej), srv.listen(port, () => res(srv.address().port))))

// ---------------- mock collector (collector mode) ----------------
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
const collected = []
const collector = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/v1/reports') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const parts = parseMultipart(Buffer.concat(chunks), req.headers['content-type'] ?? '')
      collected.push({ parts, headers: req.headers })
      const base = `http://localhost:${collector.address().port}`
      res.writeHead(201, { ...cors, 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'x', ref: 'T-1', url: `${base}/r/x`, share: { title: 'T-1 test', html: '<p>T-1</p>', text: 'T-1' } }))
    })
    return
  }
  res.writeHead(404, cors).end()
})
function parseMultipart(buf, contentType) {
  const m = /boundary=([^;]+)/.exec(contentType)
  if (!m) return []
  const delim = Buffer.from('--' + m[1].replace(/^"|"$/g, ''))
  const out = []
  let pos = buf.indexOf(delim)
  while (pos !== -1) {
    const next = buf.indexOf(delim, pos + delim.length)
    if (next === -1) break
    const part = buf.subarray(pos + delim.length + 2, next - 2) // skip CRLF after the boundary and before the next
    const sep = part.indexOf('\r\n\r\n')
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString('utf8')
      out.push({
        name: /name="([^"]*)"/.exec(head)?.[1] ?? '',
        filename: /filename="([^"]*)"/.exec(head)?.[1],
        type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1],
        body: part.subarray(sep + 4),
      })
    }
    pos = next
  }
  return out
}

// ---------------- Azure DevOps emulation (ADO mode) ----------------
const ado = { uploads: [], patches: [], n: 0 }
const j = (origin, status, body) => ({
  status,
  headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const patOf = (req) => {
  const raw = Buffer.from((req.headers()['authorization'] ?? '').replace(/^Basic /, ''), 'base64').toString('utf8')
  return raw.slice(raw.indexOf(':') + 1)
}
function adoRouter(origin) {
  return async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'OPTIONS') return route.fulfill({ ...j(origin, 204, {}), body: '' })
    if (!patOf(req).startsWith('good')) return route.fulfill(j(origin, 401, { message: 'unauthorized' }))
    const p = url.pathname
    if (req.method() === 'GET' && p.endsWith('/_apis/wit/workitemtypes')) return route.fulfill(j(origin, 200, { value: [{ name: 'Bug' }, { name: 'Task' }] }))
    if (req.method() === 'POST' && p.endsWith('/_apis/wit/attachments')) {
      const n = ++ado.n
      ado.uploads.push({ fileName: url.searchParams.get('fileName'), body: req.postDataBuffer() ?? Buffer.alloc(0) })
      return route.fulfill(j(origin, 201, { id: String(n), url: `https://dev.azure.com/o/_apis/wit/attachments/${n}` }))
    }
    if (req.method() === 'POST' && p.includes('/_apis/wit/workitems/')) {
      ado.patches.push({ path: p, body: req.postData() ?? '' })
      return route.fulfill(j(origin, 200, { id: 4242, _links: { html: { href: 'https://dev.azure.com/o/p/_workitems/edit/4242' } } }))
    }
    return route.fulfill(j(origin, 404, {}))
  }
}

// ---------------- app servers ----------------
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain' }
function staticServer(root) {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p === '/api/fail') return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false, code: 'InternalServerError' }))
    let f = path.join(root, p === '/' ? 'index.html' : p)
    const isAsset = path.extname(p) !== ''
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (isAsset) return res.writeHead(404).end('not found')
      f = path.join(root, 'index.html') // SPA fallback for /second
    }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
}

async function startApp(app, dir) {
  if (app.kind === 'static') {
    const srv = staticServer(path.join(dir, app.out))
    const port = await listen(srv)
    return { base: `http://localhost:${port}`, stop: () => srv.close() }
  }
  const port = await freePort()
  const child = spawn('node', ['dist/angular-ssr/server/server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const t0 = Date.now()
  while (!/listening/.test(log)) {
    if (child.exitCode !== null || Date.now() - t0 > 15000) throw new Error('SSR server did not start: ' + log)
    await new Promise((r) => setTimeout(r, 100))
  }
  return { base: `http://localhost:${port}`, stop: () => child.kill() }
}

function build(app, dir) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    const t = Date.now()
    const r = spawnSync('npm', ['i'], { cwd: dir, stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`npm i failed in ${app.name}`)
    console.log(`     ${app.name}: npm i ${((Date.now() - t) / 1000).toFixed(1)}s`)
  }
  const t = Date.now()
  const r = spawnSync(app.build, { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`build failed for ${app.name}:\n${(r.stdout + r.stderr).slice(-3000)}`)
  console.log(`     ${app.name}: build ${((Date.now() - t) / 1000).toFixed(1)}s`)
}

// ---------------- the checks ----------------
const hasFab = () => !!document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab')

async function newPage(ctx, app) {
  const pg = await ctx.newPage()
  const bad = []
  pg.on('pageerror', (e) => bad.push('pageerror: ' + e))
  pg.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !m.location().url.includes('/api/fail')) bad.push('console.error: ' + t)
    if (/NG0\d+/.test(t)) bad.push('Angular diagnostic: ' + t)
  })
  // Which transport does the app's HttpClient use for the failing call? Wrapped before Dalil patches the same functions.
  await pg.addInitScript(() => {
    const seen = (window.__transport = { fetch: 0, xhr: 0 })
    const f = window.fetch
    window.fetch = function (input, init) {
      if (String(input && input.url ? input.url : input).includes('/api/fail')) seen.fetch++
      return f.call(this, input, init)
    }
    const o = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (m, u) {
      if (String(u).includes('/api/fail')) seen.xhr++
      return o.apply(this, arguments)
    }
  })
  return { pg, bad }
}

const sh = (pg, sel) => pg.locator(`dalil-root >> ${sel}`)
async function exercise(pg, app) {
  await pg.waitForFunction(hasFab, null, { timeout: 20000 })
  await pg.click('#to-second')
  await pg.waitForFunction(() => document.getElementById('page')?.textContent === 'Second page')
  await pg.click('#http500')
  await pg.waitForFunction(() => document.getElementById('out').textContent.includes('500'))
  await pg.click('#toast')
  await pg.waitForSelector('.toast-error')
  await pg.waitForTimeout(1200) // let auto-snap capture the toast
}
async function openAndSubmit(pg, title) {
  await pg.keyboard.press('Control+Shift+B')
  await sh(pg, 'textarea.dalil-textarea').first().waitFor({ timeout: 20000 })
  await sh(pg, 'textarea.dalil-textarea').first().fill(title)
  await sh(pg, '.dalil-actions .dalil-primary').click()
  await sh(pg, '.dalil-sent').waitFor({ timeout: 30000 })
}

async function runApp(app, browser) {
  const dir = path.join(repo, 'examples', app.name)
  if (!noBuild) build(app, dir)
  if (!fs.existsSync(path.join(dir, app.out, 'index.html')) && !fs.existsSync(path.join(dir, app.out, 'index.csr.html')))
    throw new Error(`no build output at examples/${app.name}/${app.out} (run without --no-build)`)
  const server = await startApp(app, dir)
  try {
    const collectorUrl = `http://localhost:${collector.address().port}/v1/reports`

    // ---- SSR: the server HTML is real and has no Dalil host
    if (app.kind === 'ssr') {
      const html = await (await fetch(server.base + '/second', { headers: { accept: 'text/html' } })).text()
      check('SSR HTML is server-rendered (app content present)', html.includes(app.title) && html.includes('Second page'), html.slice(0, 120))
      check('SSR HTML has no Dalil host', !/dalil-root/i.test(html) && !/rrweb/i.test(html))
    }

    // ---- collector mode
    collected.length = 0
    const ctx = await browser.newContext()
    const { pg, bad } = await newPage(ctx, app)
    await pg.goto(`${server.base}/?collector=${encodeURIComponent(collectorUrl)}`)
    await exercise(pg, app)
    check('widget button appears (inside shadow root)', await pg.evaluate(hasFab))
    if (app.kind === 'ssr') check('page was server-rendered and hydrated (ng-server-context on app-root)', await pg.evaluate(() => !!document.querySelector('app-root[ng-server-context]')))
    const transport = await pg.evaluate(() => window.__transport)
    const want = app.transport
    check(`failing call went through ${want === 'xhr' ? 'XHR' : 'fetch'}`, transport[want] > 0 && transport[want === 'xhr' ? 'fetch' : 'xhr'] === 0, JSON.stringify(transport))
    await openAndSubmit(pg, `e2e ${app.name} collector report`)
    check('collector received one report', collected.length === 1, String(collected.length))
    const rep = collected[0]?.parts.find((p) => p.name === 'report')
    const payload = rep ? JSON.parse(rep.body.toString('utf8')) : null
    check('report part is JSON with events and verdict', !!payload && Array.isArray(payload.events) && !!payload.verdict, rep ? '' : 'no report part')
    const events = payload?.events ?? []
    check('events include a nav to /second', events.some((e) => e.type === 'nav' && e.url === '/second'), events.filter((e) => e.type === 'nav').map((e) => e.url).join(','))
    const failed500 = events.find((e) => e.type === 'request' && e.status === 500 && /\/api\/fail/.test(e.url))
    check('events show the failed request (500 /api/fail)', !!failed500, JSON.stringify(failed500 ?? events.filter((e) => e.type === 'request').map((e) => e.url + ' ' + e.status)))
    check('verdict names the backend 500', /500/.test(payload?.verdict?.headline ?? '') && /api\/fail/.test(payload?.verdict?.headline ?? ''), payload?.verdict?.headline)
    check('error toast recorded (User saw)', /Could not save the payment/.test(payload?.verdict?.userSaw ?? '') || events.some((e) => e.type === 'log' && e.source === 'toast'), payload?.verdict?.userSaw)
    const images = collected[0]?.parts.filter((p) => /^image_\d+$/.test(p.name)) ?? []
    check('at least one image part', images.length >= 1 && images.every((p) => p.body.length > 0), images.map((p) => `${p.name}:${p.body.length}B`).join(','))
    check('collector headers carry project and key', collected[0]?.headers['x-dalil-project'] != null && collected[0]?.headers['x-dalil-key'] === 'pk_demo')
    check('no console errors / page errors / NG0* diagnostics', bad.length === 0, bad.join(' | '))
    await ctx.close()

    // ---- Azure DevOps mode
    ado.uploads.length = 0
    ado.patches.length = 0
    const actx = await browser.newContext()
    await actx.route('https://dev.azure.com/**', adoRouter(server.base))
    const a = await newPage(actx, app)
    await a.pg.goto(`${server.base}/?ado=1`)
    await exercise(a.pg, app)
    await a.pg.keyboard.press('Control+Shift+B')
    await sh(a.pg, 'input[type=password]').first().waitFor({ timeout: 20000 })
    check('ADO: Connect view appears when no token is saved', true)
    await sh(a.pg, 'input[type=password]').fill('good-x')
    await sh(a.pg, '.dalil-actions .dalil-primary').click()
    await sh(a.pg, 'textarea.dalil-textarea').first().waitFor({ timeout: 20000 })
    await sh(a.pg, 'textarea.dalil-textarea').first().fill(`e2e ${app.name} ado report`)
    await sh(a.pg, '.dalil-actions .dalil-primary').click()
    await sh(a.pg, '.dalil-sent').waitFor({ timeout: 30000 })
    check('ADO: work item created', ado.patches.length === 1 && /\/workitems\/\$Bug$/.test(ado.patches[0].path), ado.patches.map((p) => p.path).join(','))
    const replay = ado.uploads.find((u) => /^replay-.*\.html$/.test(u.fileName ?? ''))
    const rtext = replay?.body.toString('utf8') ?? ''
    check('ADO: replay-*.html uploaded with the bundled player (rrwebPlayer)', !!replay && rtext.includes('rrwebPlayer') && rtext.length > 50000, `${replay?.fileName} ${rtext.length}B`)
    check('ADO: at least one image uploaded', ado.uploads.some((u) => /\.(png|jpe?g|webp|gif)$/.test(u.fileName ?? '')), ado.uploads.map((u) => u.fileName).join(','))
    check('ADO: no console errors / page errors / NG0* diagnostics', a.bad.length === 0, a.bad.join(' | '))
    await actx.close()
  } finally {
    server.stop()
  }
}

await listen(collector)
const browser = await chromium.launch()
for (const app of APPS) {
  prefix = `[${app.name}] `
  const before = failed
  try {
    await runApp(app, browser)
  } catch (e) {
    console.log(`FAIL ${prefix}${String(e?.stack ?? e)}`)
    failed++
  }
  console.log(`${failed === before ? 'PASS' : 'FAIL'} ${prefix}app summary`)
}
await browser.close()
collector.close()
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
