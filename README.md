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
  getContext={() => ({ userId, userName, role, tenant })}
/>
```

Open it with the floating button, **Ctrl/⌘ + Shift + B**, or `useDalil().open()` from your own menu.

Optional hooks:

- `log('Zod drift on /players', issues, 'error')` adds your own events to the timeline.
- `data-dalil-mask` hides an element in screenshots.
- `data-dalil-label="Save payment"` names an unlabelled button in the steps.

## What is never sent

- **Request values:** passwords, OTPs, tokens and card fields, and their header and query equivalents.
- **Any JWT**, wherever it appears.
- **Input values:** the steps say "Changed *Amount*", never what was typed.

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
