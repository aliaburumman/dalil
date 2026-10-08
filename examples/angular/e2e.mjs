// Headless check of the Angular example. Prereqs: `npm run build` in the repo root,
// `npm i --legacy-peer-deps && npx ng build && npx playwright install chromium` here.
// Run: node e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start as startMock } from './mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'dist/dalil-angular-example/browser');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ico': 'image/x-icon' };
const web = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  let f = path.join(root, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(f)) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4200, r));
const mock = await startMock(4300);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!ok) failed++;
};
const browser = await chromium.launch();

async function openAndRead(page) {
  await page.keyboard.press('Control+Shift+B');
  await page.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-dialog'), null, { timeout: 15000 });
  const text = await page.evaluate(() => document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-summary').textContent);
  const inLight = await page.evaluate(() => !!document.body.querySelector(':scope > .dalil-dialog, .dalil-dialog'));
  await page.keyboard.press('Escape');
  const gone = () => page.waitForFunction(() => !document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-dialog'), null, { timeout: 3000 });
  await gone();
  return { text, inLight };
}

// ---- functional run (init outside the zone)
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:4200/');
  await page.waitForSelector('#login');
  const fabSel = () => page.evaluate(() => !!document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'));
  check('button hidden before login', !(await fabSel()));
  await page.click('#login');
  await page.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'));
  check('button visible after login, inside shadow root', await fabSel());

  await page.click('#http500');
  await page.waitForFunction(() => document.getElementById('out').textContent.includes('500'));
  await page.waitForTimeout(500);
  let r = await openAndRead(page);
  check('HttpClient (XHR) 500 in verdict', /500/.test(r.text) && /\/api\/fail/.test(r.text), r.text.slice(0, 90));
  check('dialog rendered in shadow root, not light DOM', !r.inLight);

  await page.click('#toast');
  await page.waitForSelector('.toast-error');
  await page.waitForTimeout(500);
  r = await openAndRead(page);
  check("'User saw' line for ngx-toastr toast", /User saw: "[^"]*Could not save the payment/.test(r.text), r.text.slice(0, 160));

  await page.click('#throw');
  await page.waitForTimeout(500);
  r = await openAndRead(page);
  check('thrown error event in verdict', /Demo click handler failure/.test(r.text), r.text.slice(0, 120));

  await page.click('#login');
  await page.waitForFunction(() => !document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'));
  check('button hidden again after logout', !(await fabSel()));
  check('no unexpected page errors besides the demo throw', errors.every((m) => /Demo click handler failure/.test(m)), errors.join('|'));
  await page.close();
}

// ---- zone measurement
async function ticks(query) {
  const page = await browser.newPage();
  await page.goto('http://localhost:4200/' + query);
  await page.waitForSelector('#login');
  await page.click('#login');
  await page.waitForTimeout(4000); // let the lazy replay/autosnap chunks load
  await page.evaluate(() => (window.__ticks = 0));
  await page.waitForTimeout(5000); // idle
  const idle = await page.evaluate(() => window.__ticks);
  await page.evaluate(() => (window.__ticks = 0));
  await page.click('#typing');
  await page.keyboard.type('hello world, typing in the box', { delay: 40 });
  for (let i = 0; i < 5; i++) await page.mouse.click(600, 400);
  await page.waitForTimeout(500);
  const active = await page.evaluate(() => window.__ticks);
  await page.close();
  return { idle, active };
}
const baseline = await ticks('?nodalil=1');
const outside = await ticks('');
const inside = await ticks('?inzone=1');
console.log(`TICKS no dalil (baseline): idle(5s)=${baseline.idle} typing+clicks=${baseline.active}`);
console.log(`TICKS runOutsideAngular: idle(5s)=${outside.idle} typing+clicks=${outside.active}`);
console.log(`TICKS inside zone:       idle(5s)=${inside.idle} typing+clicks=${inside.active}`);
check('outside-zone ticks <= inside-zone ticks', outside.idle + outside.active <= inside.idle + inside.active);

await browser.close();
web.close();
mock.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
