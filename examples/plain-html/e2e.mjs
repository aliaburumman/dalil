// Headless check of the plain-html example (uses playwright from ../angular/node_modules).
// Prereq: `npm run build` in the repo root. Run: node examples/plain-html/e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../angular/node_modules/playwright/index.mjs';
import { start as startMock } from '../angular/mock-server.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const web = http.createServer((req, res) => {
  const f = path.join(repo, new URL(req.url, 'http://x').pathname);
  if (!f.startsWith(repo) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4201, r));
const mock = await startMock(4300);
let failed = 0;
const check = (n, ok, x = '') => (console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' :: ' + x : ''}`), ok || failed++);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4201/examples/plain-html/index.html');
await page.waitForFunction(() => document.querySelector('dalil-root')?.shadowRoot?.querySelector('.dalil-fab'));
check('global script mounted the button in a shadow root', true);

async function verdictAfter(selector, expectInOut) {
  await page.click(selector);
  await page.waitForFunction((t) => document.getElementById('out').textContent.includes(t), expectInOut);
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForFunction(() => document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'), null, { timeout: 15000 });
  const text = await page.evaluate(() => document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-summary').textContent);
  await page.evaluate(() => document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-actions .dalil-btn').click());
  await page.waitForFunction(() => !document.querySelector('dalil-root').shadowRoot.querySelector('.dalil-dialog'));
  return text;
}
let t = await verdictAfter('#fetch500', 'fetch -> 500');
check('fetch 500 verdict', /Backend error: 500 on GET \/api\/fail/.test(t), t.slice(0, 80));
t = await verdictAfter('#xhr500', 'xhr -> 500');
check('XHR 500 verdict', /Backend error: 500 on POST \/api\/fail/.test(t), t.slice(0, 80));

await browser.close();
web.close();
mock.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
