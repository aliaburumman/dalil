# Dalil (دليل)

A drop-in **"Report a bug"** button for React apps, built for testers who aren't QA.

The tester writes one sentence. Dalil attaches the rest:

- **Steps**: the last few minutes of pages, clicked buttons, form submits and API calls, in plain words.
- **Screenshot**, taken before the dialog opens, with pen, box and blur tools. Testers can paste more images.
- **A best-guess verdict**: *Backend error: 500 on POST /payments*, *Frontend error*, *Validation*, *Permission*, *Network*, or *Behaviour / UX*, linked to the event that produced it.
- **A replayable curl** for every failed request. The token is always `$TOKEN`, never the real one.
- **`X-Request-Id`** on your API calls, so a report points at the exact server log line.

Reports go to **your own collector**, a small Cloudflare Worker (D1 + R2 + Resend) in [`worker/`](worker/). Nothing goes to a third party.

## Install

```bash
npm i dalil
```

```tsx
import { DalilProvider } from 'dalil/react'

<DalilProvider
  project="myapp"
  publicKey={import.meta.env.VITE_DALIL_KEY}
  endpoint="https://dalil.example.com/v1/reports"
  apiOrigins={['https://api.example.com']}  // only these get X-Request-Id
  enabled={isLoggedIn}
  theme="light"                                 // 'light' | 'dark' | 'system' (default: follows the OS)
  accent="var(--primary)"                       // any CSS colour; default blue
  accentForeground="var(--primary-foreground)"  // pass with accent; default white
  getContext={() => ({ userId, userName, role, tenant })}
  replay                                        // default true; replay={false} turns the screen recording off
/>
```

`theme` forces light or dark so the dialog matches your app's own switch rather than the OS. `accent` / `accentForeground` set the brand colour (pass both). Plural labels: `labels={{ steps: '{n} steps', stepsOne: '{n} step', requests: '{n} requests ({m} failed)', requestsOne: '{n} request ({m} failed)' }}`.

Open it with the floating button, **Ctrl/⌘ + Shift + B**, or `useDalil().open()` from your own menu.

Optional hooks:

- `log('Zod drift on /players', issues, 'error')` adds your own events to the timeline.
- `data-dalil-mask` hides an element in screenshots and masks its text in the screen recording.
- `data-dalil-ignore` keeps an element out of screenshots and blocks it from the recording.
- `data-dalil-label="Save payment"` names an unlabelled button in the steps.

## Any web app: `dalil/web` (0.3)

No React needed. One script tag, or `import { init } from 'dalil/web'`. The UI renders inside a Shadow DOM, so host CSS (Tailwind, Bootstrap, Material) cannot break it.

```html
<script src="https://cdn.jsdelivr.net/npm/dalil@0.3/dist/dalil.global.js"></script>
<script>
  Dalil.init({ project: 'myapp', publicKey: 'pk_...', endpoint: 'https://dalil.example.com/v1/reports',
               apiOrigins: ['https://api.example.com'], enabled: false })
  // after login:
  Dalil.update({ enabled: true, getContext: () => ({ userId, userName, tenant }) })
</script>
```

API: `init(config)` (idempotent; the recorder starts immediately, the UI mounts after `DOMContentLoaded`), `update(partial)` (enabled, getContext, labels, dir, theme, accent at runtime), `open()`, `log(msg, data?, level?)`, `destroy()`. The CDN build is about 57 KB gzipped (Preact, replay and screenshots inlined). The ESM entry loads replay, screenshots and the dialog lazily.

Try it: `examples/plain-html/index.html`. Serve the repo root with any static server (`npx serve .`) and open `/examples/plain-html/`; the two buttons fire a failing fetch and a failing XHR. For a real 500 point `API` at a server that returns one.

## Captured automatically (0.2)

Two things happen while `enabled` is true, so the reporter doesn't have to remember what happened:

- **Auto-snapshots.** When a request fails, an error is thrown, or an error toast appears, Dalil takes a screenshot about 0.3 to 0.7 s later and keeps the last three in memory. The toast is found generically by watching for `[data-sonner-toast][data-type="error"]` (sonner), and its text is added to the timeline as `Toast: …`. At most one capture per 4 s, never while the tab is hidden, and it stops trying on a page where a capture was slow (over 800 ms). The tester sees them under "Captured automatically" in the dialog and can remove any before sending.
- **Screen recording.** The last one to two minutes of the page are recorded as a DOM replay ([rrweb](https://github.com/rrweb-io/rrweb)), with failed requests, errors and toasts as jump markers. The recorder is a separate chunk loaded when the browser is idle. The dialog says "Screen recording: last 1m 48s (inputs hidden)" and lets the tester exclude it. Nothing is written to browser storage; if recording or compressing isn't possible (no `CompressionStream`), the report says so instead.

The on-open screenshot also works on pages with cross-origin images: if the first attempt fails, it is retried without them (the images show as gaps).

### What the recording hides, and what it doesn't

Hidden: every input and textarea value, including passwords (masked as `***`); text inside `[contenteditable]` and `[data-dalil-mask]`; `iframe`, `canvas` and `[data-dalil-ignore]` elements are not recorded at all. Before upload, JWTs and `Bearer` tokens are scrubbed from the recording and query strings are redacted in recorded `src`/`href`/`srcset` URLs; URLs carrying signatures or tokens lose their whole query.

**Not hidden:** visible page text (tables, names, amounts, a combobox's chosen label). That is the point: the developer sees what the tester saw. Put `data-dalil-mask` on anything sensitive that is shown as plain text, or set `replay={false}`. Pages that produce an unusually heavy recording (over about 30,000 events or 15 MB) stop recording and say so in the report.

## Content-Security-Policy

If the host page sends a `Content-Security-Policy`, add the collector origin to `connect-src`, for example `connect-src 'self' https://dalil.example.com`. Without it the browser blocks the upload; dalil saves the report on the device, retries it on the next page load, and logs a `[dalil] Could not reach the collector...` error in the console.

To have images inlined in screenshots, also list the hosts serving those images in `connect-src`, because html-to-image fetches them.

## What is never sent

- **Request values:** passwords, OTPs, tokens and card fields, and their header and query equivalents.
- **Any JWT**, wherever it appears.
- **Input values:** the steps say "Changed *Amount*", never what was typed, and the recording masks them too.

The collector scrubs a second time on the server and flags any report where it had to.

## Backend

Accept `X-Request-Id` (GUIDs only), echo it, and log one line for every 4xx and 5xx that includes `rid=<id>`. Your server logs can then be searched by the id in a report.

## Collector

See [`worker/README.md`](worker/README.md) for D1, R2, Resend, Cloudflare Access and deploy.

## Develop

```bash
npm i && npm test && npm run demo
```

MIT
