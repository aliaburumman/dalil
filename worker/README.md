# Dalil collector (Cloudflare Worker)

Receives bug reports from the `dalil` widget, stores them in D1 + R2, emails them through
Resend, and serves a triage page. Design: `../docs/design.md` §3. Payload contract:
`src/payload.ts` (a copy of `../src/core/types.ts`; keep `PAYLOAD_VERSION` in sync).

Plain fetch handler, no framework. Its own package — run everything from `worker/`.

| Route | What |
|---|---|
| `OPTIONS /v1/reports` | CORS preflight, answered only for allowed origins |
| `POST /v1/reports` | multipart ingest, parts below (payload v1 and v2 accepted) |
| `GET /r/:id` | triage page (behind Cloudflare Access) |
| `GET /r/:id/img/:part` | image streamed from R2 |
| `GET /r/:id/auto/:n` | auto snapshot `n` (0-2) |
| `GET /r/:id/replay` | the stored gzip, `application/gzip`, `private, no-store` |
| `GET /assets/rrweb-player.<ver>.js|css` | vendored player (static assets) |
| `POST /r/:id/status` | `status=new|seen|fixed|wontfix` |
| cron (daily 03:17 UTC) | delete D1 rows > 90 days, prune rate-limit hits, retry `failed` emails (≤ 7 days old) |

## Ingest parts (payload v2)

Limits live in `src/limits.ts`, a copy of `../src/core/limits.ts` (change both together).

| Part | Max | Per-part cap |
|---|---|---|
| `report` (JSON, `v` is 1 or 2) | 1 | 1 MB |
| `image_0..image_5` (jpeg/png/webp) | 6 | 2 MB each |
| `auto_0..auto_2` (jpeg/png/webp, failure snapshots) | 3 | 400 KB each |
| `replay` (gzip of rrweb events) | 1 | 5 MB gzip, 40 MB decompressed |
| whole body | | 8 MB |

The replay must start with the gzip magic bytes (`1f 8b`). The decompressed size is
checked by streaming it through `DecompressionStream` and counting bytes (never stored,
never recompressed), so a gzip bomb gets `413`. A non-gzip replay gets `400`. Replay JSON
is scrubbed by the client, not here. Stored as `reports/{project}/{id}/replay.json.gz` and
`auto_N.jpg`. At most 10 reports with a replay per ip+project per hour (D1 table
`replay_hits`); over that the report is accepted, the replay is dropped and
`replay_dropped = 1`.

## Replay player and static assets

`rrweb-player` is pinned to an exact version in `package.json` and vendored: `npm run vendor:player`
copies its UMD build and CSS to `public/assets/rrweb-player.<ver>.js|css` and writes
`src/player-version.ts`. `wrangler.jsonc` has `"assets": {"directory": "./public", "binding": "ASSETS"}`;
the Worker serves `/assets/rrweb-player.*` through `env.ASSETS` (assets are not part of the
Worker bundle, so the script stays about 43 KB). Nothing loads from a CDN. The report page CSP is:
`default-src 'none'; script-src 'nonce-…' 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data: https:`.
The page fetches `/r/:id/replay`, decompresses with `DecompressionStream`, and mounts the player;
`dalil` custom events (type 5) become "Jump to" buttons (`player.goto(t - first - 1500)`).

## Migrations

New in v0.2 (`migrations/0002_replay.sql`: `has_replay`, `auto_snaps`, `replay_dropped`, `replay_hits`).
Apply before deploying the new Worker:

```sh
npx wrangler d1 migrations apply dalil --remote
```

## Email modes, digest and reports page

`migrations/0003_digest.sql` adds `projects.email_mode` (`digest` default | `each`), `projects.digest_tz`
(informational), `reports.digested_at` and `reports.user_saw`. Existing reports are backfilled as
already digested. Apply it before deploying:

```sh
npx wrangler d1 migrations apply dalil --remote
```

- **`digest` (default)**: a new report is stored with `email_status = 'digest'` and nothing is sent,
  except **blockers**, which email immediately (`sent`/`failed`) as before. A blocker keeps
  `digested_at = NULL`, so it also appears in the next digest marked "(already emailed)".
- **`each`**: every report emails immediately (the old behaviour).
- **Digest schedule**: cron `0 6,18 * * *` UTC = 09:00 and 21:00 Asia/Amman. One email per project
  with `notify_emails` and at least one report with `digested_at IS NULL` (max 200, then "+N more");
  no email when there is nothing. `digested_at` is set only for the rows included, and only after
  Resend accepts the send, so a failure retries at the next run. The daily `17 3 * * *` cron stays
  maintenance only (retention, retrying `failed` per-report emails) and never touches `digest` rows.
- Switch a project: `npx wrangler d1 execute dalil --remote --command "UPDATE projects SET email_mode='each' WHERE id='space'"`
  (back with `'digest'`).
- **Reports list**: `GET /` (all projects) and `GET /p/:project`, newest first, 50 per page (`?page=`),
  filters `?status=open|all|new|seen|fixed|wontfix` (default `open` = new+seen), `?severity=`, `?kind=`.
  Both routes (and `POST /r/:id/status`) return 403 unless the request carries a valid Cloudflare
  Access JWT (see "Verifying the Access JWT" below); the page header shows the signed-in email.
  `GET /r/:id` and its image/replay routes are not yet verified (unguessable ids; hardening later).

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
`401` bad project/key, `403` origin, `413` > 8 MB body, > 1 MB report, oversize replay/auto part or gzip bomb, `415` not
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

Access protects the triage page at the edge; the Worker additionally verifies the JWT for the
reports list and status changes.

1. **Self-hosted app "Dalil"** — domain `dalil.thecourtspace.com` (whole host).
   Policy: *Allow*, include your email(s), login method One-time PIN.
2. **Self-hosted app "Dalil ingest"** — domain `dalil.thecourtspace.com`, path `v1/`
   (covers `/v1/*`). Policy: action **Bypass**, include *Everyone*. The more specific path
   wins, so browsers of testers reach ingest without an Access login.

Check after setup: `curl -i https://dalil.thecourtspace.com/r/x` should redirect to the
Access login; `curl -i -X OPTIONS https://dalil.thecourtspace.com/v1/reports -H 'Origin: https://evil.example'`
should return the Worker's `403`, not an Access page.

### Verifying the Access JWT

Set two vars in `wrangler.jsonc` (`vars`) after creating the Access application, then deploy:

| Var | Where to find it |
|---|---|
| `ACCESS_AUD` | Zero Trust -> Access -> Applications -> the "Dalil" app -> Overview, "Application Audience (AUD) Tag" |
| `ACCESS_TEAM_DOMAIN` | `<team name>.cloudflareaccess.com`; the team name is under Zero Trust -> Settings -> Custom pages |

The Worker fetches `https://<team domain>/cdn-cgi/access/certs` (cached 1 hour), verifies the RS256
signature, `aud`, `iss` and `exp`, and reads the JWT from `Cf-Access-Jwt-Assertion` (or the
`CF_Authorization` cookie). If either var is empty the list and status routes fail closed with 403.

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
