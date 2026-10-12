// Real-browser end-to-end test of the Azure DevOps (no server) mode against the test page in site/ado-test/.
// dev.azure.com is emulated with page.route, so no network and no real org/PAT is needed.
// Prereqs: `npm ci`, `npm run build`, `npm run build:ado-site`, `npx playwright install chromium`.
// Run: npm run e2e:ado   (port 4203, override with WEB_PORT)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const siteDir = path.join(repo, 'site', 'ado-test')
const WEB_PORT = Number(process.env.WEB_PORT ?? 4203)
const WEB = `http://localhost:${WEB_PORT}`
const GOOD = 'good-PAT-zq81x7'
const BAD = 'bad-PAT-zq81x7'
const ORG = 'o'
const PROJ = 'p'

let failed = 0
const check = (n, ok, x = '') => (console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' :: ' + x : ''}`), ok || failed++)

if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
  console.log('FAIL site/ado-test missing: run `npm run build && npm run build:ado-site`')
  process.exit(1)
}

// ---- static server for the test site (missing paths 404, like GitHub Pages) ----
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }
const web = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  const f = path.join(siteDir, p === '/' ? 'index.html' : p)
  if (!f.startsWith(siteDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' })
  fs.createReadStream(f).pipe(res)
})

// ---- Azure DevOps emulation ----
const cors = { 'access-control-allow-origin': WEB, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
const state = { create: 'ok', urls: [], uploads: [], patches: [], typesCalls: 0, n: 0 }
const patOf = (req) => {
  const h = req.headers()['authorization'] ?? ''
  const raw = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString('utf8')
  return raw.slice(raw.indexOf(':') + 1)
}
const j = (status, body) => ({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function adoRoute(route) {
  const req = route.request()
  const url = new URL(req.url())
  state.urls.push(req.url())
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const pat = patOf(req)
  if (!pat.startsWith('good')) return route.fulfill(j(401, { message: 'unauthorized' }))
  const p = url.pathname
  if (req.method() === 'GET' && p.endsWith('/_apis/wit/workitemtypes')) {
    state.typesCalls++
    return route.fulfill(j(200, { value: [{ name: 'Bug' }, { name: 'Task' }] }))
  }
  if (req.method() === 'POST' && p.endsWith('/_apis/wit/attachments')) {
    const n = ++state.n
    state.uploads.push({ fileName: url.searchParams.get('fileName'), body: req.postDataBuffer() ?? Buffer.alloc(0), n })
    return route.fulfill(j(201, { id: String(n), url: `https://dev.azure.com/${ORG}/_apis/wit/attachments/${n}` }))
  }
  if (req.method() === 'POST' && p.includes('/_apis/wit/workitems/')) {
    state.patches.push({ path: p, body: req.postData() ?? '', contentType: req.headers()['content-type'] })
    if (state.create === 'abort') return route.abort('failed')
    if (state.create === '401') return route.fulfill(j(401, { message: 'unauthorized' }))
    return route.fulfill(j(200, { id: 4242, _links: { html: { href: `https://dev.azure.com/${ORG}/${PROJ}/_workitems/edit/4242` } } }))
  }
  return route.fulfill(j(404, {}))
}

async function main() {
  await new Promise((r, rej) => (web.once('error', rej), web.listen(WEB_PORT, r)))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ acceptDownloads: true })
  await ctx.route('https://dev.azure.com/**', adoRoute)
  const pg = await ctx.newPage()
  const errors = []
  pg.on('pageerror', (e) => errors.push(String(e)))
  const external = []
  pg.on('request', (r) => {
    const u = new URL(r.url())
    if (/^https?:$/.test(u.protocol) && u.origin !== WEB && u.hostname !== 'dev.azure.com') external.push(r.url())
  })
  const sh = (sel) => pg.locator(`dalil-root >> ${sel}`)
  const dialog = (sel = '') => sh(`.dalil-dialog${sel}`)

  const openWidget = async () => {
    await pg.keyboard.press('Control+Shift+B')
  }
  const waitDialogKind = async (kind) => {
    // 'connect' = password field, 'report' = title textarea
    const sel = kind === 'connect' ? 'input[type=password]' : 'textarea.dalil-textarea'
    await sh(sel).first().waitFor({ timeout: 20000 })
  }
  const enterPat = async (pat) => {
    await sh('input[type=password]').fill(pat)
    await sh('.dalil-actions .dalil-primary').click()
  }
  const submitTitle = async (title) => {
    await sh('textarea.dalil-textarea').first().fill(title)
    await sh('.dalil-actions .dalil-primary').click()
  }
  const triggerEvidence = async () => {
    await pg.click('#guest')
    await pg.fill('#guest', 'Layla')
    await pg.click('#step')
    await pg.click('#book')
    await pg.waitForFunction(() => document.getElementById('out').textContent.includes('404'))
    await pg.click('#toast')
    await pg.waitForTimeout(1200) // let auto-snap capture the toast
  }
  const load = async () => {
    await pg.goto(WEB + '/')
    await pg.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'))
  }

  // ---- Flow A: first run, Connect view, Sent panel ----
  await pg.goto(WEB + '/')
  await pg.fill('#org', ORG)
  await pg.fill('#project', PROJ)
  await pg.click('#save')
  await pg.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'), null, { timeout: 15000 })
  check('A: settings saved to localStorage', await pg.evaluate(() => !!localStorage.getItem('dalil-ado-test')))
  await triggerEvidence()
  await openWidget()
  await waitDialogKind('connect')
  check('A: Connect view appears when no token is stored', true)
  await enterPat(GOOD)
  await waitDialogKind('report')
  check('A: token validated, report dialog opens', state.typesCalls >= 1)
  const title = 'فشل حفظ الحجز - booking save failed'
  await submitTitle(title)
  await sh('.dalil-sent').waitFor({ timeout: 30000 })
  const sentText = await sh('.dalil-sent .dalil-head h2').innerText()
  check('A: Sent panel shows "Bug #4242"', /Bug #4242/.test(sentText), sentText)
  const link = sh('.dalil-sent a.dalil-btn')
  check('A: Open link points at the work item', (await link.getAttribute('href')) === `https://dev.azure.com/${ORG}/${PROJ}/_workitems/edit/4242`)
  const images = state.uploads.filter((u) => /\.(png|jpe?g|webp|gif)$/.test(u.fileName ?? ''))
  check('A: at least one image uploaded', images.length >= 1, images.map((u) => u.fileName).join(','))
  const replay = state.uploads.find((u) => /^replay-.*\.html$/.test(u.fileName ?? ''))
  check('A: replay-*.html uploaded', !!replay, state.uploads.map((u) => u.fileName).join(','))
  const rtext = replay?.body.toString('utf8') ?? ''
  check('A: replay html embeds the rrweb player', /rrweb/i.test(rtext) && rtext.length > 50000, String(rtext.length))
  const patchReq = state.patches[state.patches.length - 1]
  const patch = JSON.parse(patchReq?.body || '[]')
  const field = (name) => patch.find((o) => o.path === `/fields/${name}`)?.value
  check('A: create targets the Bug type, json-patch content type', /\/workitems\/\$Bug$/.test(patchReq?.path ?? '') && /json-patch\+json/.test(patchReq?.contentType ?? ''), patchReq?.path)
  check('A: System.Title equals the typed title', field('System.Title') === title, JSON.stringify(field('System.Title')))
  const rels = patch.filter((o) => o.path === '/relations/-' && o.value?.rel === 'AttachedFile')
  check('A: AttachedFile relations cover images + replay', rels.length >= images.length + 1 && rels.every((r) => /attachments\/\d+$/.test(r.value.url)), String(rels.length))
  check('A: tags contain dalil', /(^|; )dalil(;|$)/.test(field('System.Tags') ?? ''), field('System.Tags'))
  const steps = field('Microsoft.VSTS.TCM.ReproSteps') ?? ''
  check('A: ReproSteps has <img src= with attachment urls', /<img src="https:\/\/dev\.azure\.com\/o\/_apis\/wit\/attachments\/\d+"/.test(steps))
  const b64 = Buffer.from(':' + GOOD).toString('base64')
  const leaks = (s) => s.includes(GOOD) || s.includes(b64)
  check('A: PAT never appears in any request URL', !state.urls.some(leaks))
  check('A: PAT never appears in any uploaded body or the work item patch', !state.uploads.some((u) => leaks(u.body.toString('latin1'))) && !state.patches.some((x) => leaks(x.body)))
  check('A: no request left the page except to dev.azure.com', external.length === 0, external.join(','))
  await sh('.dalil-sent .dalil-btn.dalil-primary').click()

  // ---- Flow B: forget token, bad PAT -> inline 401, not saved ----
  await load()
  await triggerEvidence()
  await openWidget()
  await waitDialogKind('report')
  await dialog().getByRole('button', { name: 'Forget token' }).click()
  await pg.waitForFunction(() => !document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'))
  check('B: Forget token closes the dialog', true)
  await openWidget()
  await waitDialogKind('connect')
  check('B: Connect view appears again after forgetting', true)
  await enterPat(BAD)
  await sh('.dalil-field .dalil-error').waitFor({ timeout: 10000 })
  const errText = await sh('.dalil-field .dalil-error').innerText()
  check('B: inline error shown for a rejected token', /rejected this token/i.test(errText), errText)
  check('B: still on Connect view (not saved)', await sh('input[type=password]').isVisible())
  await pg.keyboard.press('Escape')
  await pg.waitForFunction(() => !document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'))
  await openWidget()
  await waitDialogKind('connect')
  check('B: bad token was not stored (Connect view again)', true)

  // ---- Flow C: create returns 401 -> error panel, Download evidence ----
  state.create = '401'
  await enterPat(GOOD)
  await waitDialogKind('report')
  await submitTitle('create 401 case')
  await sh('[role=alertdialog]').waitFor({ timeout: 30000 })
  const cText = await sh('[role=alertdialog] h2').innerText()
  check('C: error panel for a rejected create (token problem)', /token/i.test(cText), cText)
  check('C: Update token button present', await sh('[role=alertdialog] button', ).filter({ hasText: 'Update token' }).isVisible())
  await pg.waitForTimeout(800) // the zip is built in the background on mount
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 15000 }), sh('[role=alertdialog] button').filter({ hasText: 'Download evidence' }).click()])
  const dlPath = await dl.path()
  const zip = fs.readFileSync(dlPath)
  check('C: evidence zip downloaded, non-empty, starts with PK', zip.length > 100 && zip.subarray(0, 2).toString() === 'PK', `${dl.suggestedFilename()} ${zip.length}B`)
  check('C: zip does not contain the PAT', !leaks(zip.toString('latin1')))
  await sh('[role=alertdialog] button').filter({ hasText: 'Done' }).click()
  await pg.waitForFunction(() => !document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'))

  // ---- Flow D: create aborts (network) -> unreachable + Try again ----
  state.create = 'abort'
  await openWidget()
  await waitDialogKind('report') // token was saved by flow C's validation
  await submitTitle('create unreachable case')
  await sh('[role=alertdialog]').waitFor({ timeout: 30000 })
  const dText = await sh('[role=alertdialog] h2').innerText()
  check("D: \"Couldn't reach Azure DevOps\" shown", /Couldn't reach Azure DevOps/.test(dText), dText)
  state.create = 'ok'
  await sh('[role=alertdialog] button').filter({ hasText: 'Try again' }).click()
  await sh('.dalil-sent').waitFor({ timeout: 30000 })
  const dSent = await sh('.dalil-sent .dalil-head h2').innerText()
  check('D: Try again after recovery shows the Sent panel', /Bug #4242/.test(dSent), dSent)

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
}

try {
  await main()
} catch (e) {
  console.log(`FAIL ${String(e?.stack ?? e)}`)
  failed++
}
web.close()
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
