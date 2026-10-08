# Dalil collector (Cloudflare Worker)

Receives bug reports from the `dalil` widget, stores them in D1 + R2, emails them through
Resend, and serves a triage page. Design: `../docs/design.md` §3. Payload contract:
`src/payload.ts` (a copy of `../src/core/types.ts`; keep `PAYLOAD_VERSION` in sync).

Plain fetch handler, no framework. Its own package — run everything from `worker/`.

| Route | What |
|---|---|
| `OPTIONS /v1/reports` | CORS preflight, answered only for allowed origins |
| `POST /v1/reports` | multipart ingest: part `report` (JSON ≤ 1 MB) + `image_0..image_5` (jpeg/png/webp) |
| `GET /r/:id` | triage page (behind Cloudflare Access) |
| `GET /r/:id/img/:part` | image streamed from R2 |
| `POST /r/:id/status` | `status=new|seen|fixed|wontfix` |
| cron (daily 03:17 UTC) | delete D1 rows > 90 days, prune rate-limit hits, retry `failed` emails (≤ 7 days old) |

## Client contract

The widget must send these headers on `POST /v1/reports`:

```
X-Dalil-Project: space
X-Dalil-Key: <project public_key>
```

Both are checked, together with `Origin` against the project's `allowed_origins`, *before*
the body is read. A `report.project` that differs from `X-Dalil-Project` is rejected.

Preflight caveat: browsers never send header **values** in an `OPTIONS` preflight, only
the header names, so the preflight cannot see `X-Dalil-Project`. The Worker therefore
allows the preflight when the origin belongs to **any** project. To scope it to one
project, point the widget at `https://dalil.thecourtspace.com/v1/reports?project=space`;
then only that project's origins pass. Either way, the POST itself is checked per project.

Responses: `201 {id, ref, url}` (e.g. `ref: "SPACE-142"`), `400` bad body/parts/version,
`401` bad project/key, `403` origin, `413` > 8 MB body or > 1 MB report, `415` not
multipart, `429` rate limited, `500` storage failed (client should keep its pending copy).

## Rate limiting

Design target: 20 reports per hour per IP per project. Workers Rate Limiting only allows a
`period` of 10 or 60 seconds, so it cannot express one hour. Two layers:

1. `RATE_LIMITER` binding, 20 per 60 s per `project:ip` — the cheap burst guard.
   It is per Cloudflare location and eventually consistent, by design.
2. A D1 count over `ingest_hits` (IP stored only as SHA-256): `HOURLY_LIMIT` (default 20)
   accepted attempts per project + IP in the last hour. Pruned daily by the cron.

## Secret scrub

The client redacts. As a second line, the Worker replaces any JWT
(`eyJ…\.…\.…` → `[JWT]`) and any `Bearer <x>` where `x` is not `$TOKEN`
(→ `Bearer [REDACTED]`) anywhere in the report JSON. If anything matched, the row gets
`scrubbed = 1`. Reports are never rejected for it. QA target: zero `scrubbed` rows.

## One-time setup

Prerequisite: `npm i`, then `npx wrangler login` (you, interactively).

```sh
cd worker

# 1. D1 — paste the printed database_id into wrangler.jsonc (replaces the zeros)
npx wrangler d1 create dalil
npx wrangler d1 migrations apply dalil --remote

# 2. R2 bucket + 90-day expiry for report objects (the PII cap)
npx wrangler r2 bucket create dalil-reports
npx wrangler r2 bucket lifecycle add dalil-reports expire-reports reports/ --expire-days 90

# 3. Resend API key (domain thecourtspace.com verified in Resend; sender = MAIL_FROM)
npx wrangler secret put RESEND_API_KEY

# 4. Rate limiter: set ratelimits[0].namespace_id in wrangler.jsonc to any integer
#    unique in your account (placeholder is 1001).

# 5. Deploy (custom domain dalil.thecourtspace.com comes from `routes` in wrangler.jsonc;
#    the thecourtspace.com zone must be on this Cloudflare account)
npx wrangler deploy
```

### Register projects

Generate a public key per project (`openssl rand -hex 16`) and set it as the app's
`VITE_DALIL_KEY`. It is public by nature; the origin check and rate limit are the guard.

```sh
npx wrangler d1 execute dalil --remote --command "
INSERT INTO projects (id, name, public_key, allowed_origins, notify_emails, key_prefix, created_at) VALUES
 ('space', 'Space', '<space-public-key>',
  '[\"https://portal.thecourtspace.com\",\"http://localhost:5173\"]',
  '[\"you@example.com\"]', 'SPACE', unixepoch() * 1000),
 ('kings', 'Kings', '<kings-public-key>',
  '[\"https://portal.kingsjo.com\"]',
  '[\"you@example.com\"]', 'KINGS', unixepoch() * 1000);"
```

Origins must match exactly (scheme + host + port, no trailing slash). Replace the example
origins with the real portal URLs. `notify_emails = '[]'` stores reports without emailing
(`email_status = 'skipped'`).

### Cloudflare Access (two applications)

The Worker has no auth code; Access protects the triage page.

1. **Self-hosted app "Dalil"** — domain `dalil.thecourtspace.com` (whole host).
   Policy: *Allow*, include your email(s), login method One-time PIN.
2. **Self-hosted app "Dalil ingest"** — domain `dalil.thecourtspace.com`, path `v1/`
   (covers `/v1/*`). Policy: action **Bypass**, include *Everyone*. The more specific path
   wins, so browsers of testers reach ingest without an Access login.

Check after setup: `curl -i https://dalil.thecourtspace.com/r/x` should redirect to the
Access login; `curl -i -X OPTIONS https://dalil.thecourtspace.com/v1/reports -H 'Origin: https://evil.example'`
should return the Worker's `403`, not an Access page.

## Develop and test

```sh
cp .dev.vars.example .dev.vars          # local Resend key (optional)
npx wrangler d1 migrations apply dalil --local
npx wrangler dev

npx vitest run       # miniflare: local D1/R2, Resend mocked by stubbing fetch
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir dist
```

## Needs a live check

- **Resend inline image**: the screenshot is attached with `content_id: "screenshot"` and
  referenced as `<img src="cid:screenshot">`. `content_id` is the REST field name per
  Resend's inline-image docs; confirm with one real send.
- **Rate limit binding**: miniflare simulates it; confirm the namespace id deploys and
  that a burst of 21 POSTs from one IP within a minute gets a 429.

## Data

- D1 `reports`: one row per report (ref = `projects.key_prefix` + `-` + `seq`).
  `email_status`: `pending | sent | failed | skipped`.
- R2 `reports/{project}/{id}/report.json` (scrubbed payload) and `…/image_N`.
- Retention: D1 rows deleted by the cron at 90 days; R2 objects by the lifecycle rule.
