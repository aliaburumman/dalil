// Route table. index.ts is deny-by-default: only `public: true` routes run without Cloudflare Access.
//
//   PUBLIC (no Access JWT; the ingest path is protected by project key + origin allowlist)
//     OPTIONS /v1/reports                      CORS preflight
//     POST    /v1/reports                      report ingest
//     GET     /assets/rrweb-player.<ver>.(js|css)
//
//   GUARDED (valid Access JWT required; anything else, including unknown paths, gets 403)
//     GET  /                                   reports list (all projects)
//     GET  /p/:project                         reports list (one project)
//     GET  /r/:id                              report page
//     GET  /r/:id/img/:part                    screenshot
//     GET  /r/:id/auto/[0-2]                   automatic snapshot
//     GET  /r/:id/replay                       recording
//     POST /r/:id/status                       change status (+ same-origin check)
//     POST /r/:id/workitem                     create Azure DevOps work item (404 unless configured; same-origin check)
import type { Env } from './env'
import { handleIngest, handlePreflight } from './ingest'
import { handleList } from './list'
import { handleAuto, handleImage, handlePage, handleReplay, handleStatus, handleWorkItem } from './page'

export type User = { email: string }

export interface RouteCtx {
  req: Request
  env: Env
  ctx: ExecutionContext
  match: RegExpMatchArray
  /** Non-null for guarded routes; null for public ones. */
  user: User | null
}

export interface Route {
  method: 'GET' | 'POST' | 'OPTIONS'
  pattern: RegExp
  public: boolean
  handler: (c: RouteCtx) => Promise<Response>
}

const ROOT = /^\/$/
const INGEST = /^\/v1\/reports$/
const LIST_PROJECT = /^\/p\/([^/]+)$/
const REPORT_PAGE = /^\/r\/([^/]+)$/
const REPORT_IMG = /^\/r\/([^/]+)\/img\/([^/]+)$/
const REPORT_AUTO = /^\/r\/([^/]+)\/auto\/([0-2])$/
const REPORT_REPLAY = /^\/r\/([^/]+)\/replay$/
const ASSET = /^\/assets\/rrweb-player\.[0-9A-Za-z.-]+\.(js|css)$/
const REPORT_STATUS = /^\/r\/([^/]+)\/status$/
const REPORT_WORKITEM = /^\/r\/([^/]+)\/workitem$/

export const ROUTES: Route[] = [
  { method: 'OPTIONS', pattern: INGEST, public: true, handler: ({ req, env }) => handlePreflight(req, env) },
  { method: 'POST', pattern: INGEST, public: true, handler: ({ req, env, ctx }) => handleIngest(req, env, ctx) },
  { method: 'GET', pattern: ASSET, public: true, handler: ({ req, env }) => env.ASSETS.fetch(req) },

  { method: 'GET', pattern: ROOT, public: false, handler: ({ req, env, user }) => handleList(req, env, null, user!) },
  { method: 'GET', pattern: LIST_PROJECT, public: false, handler: ({ req, env, match, user }) => handleList(req, env, decodeURIComponent(match[1]!), user!) },
  { method: 'GET', pattern: REPORT_PAGE, public: false, handler: ({ req, env, match, user }) => handlePage(env, match[1]!, user!, new URL(req.url).searchParams.get('wi_error')) },
  { method: 'GET', pattern: REPORT_IMG, public: false, handler: ({ env, match }) => handleImage(env, match[1]!, match[2]!) },
  { method: 'GET', pattern: REPORT_AUTO, public: false, handler: ({ env, match }) => handleAuto(env, match[1]!, match[2]!) },
  { method: 'GET', pattern: REPORT_REPLAY, public: false, handler: ({ env, match }) => handleReplay(env, match[1]!) },
  { method: 'POST', pattern: REPORT_STATUS, public: false, handler: ({ req, env, match }) => handleStatus(req, env, match[1]!) },
  { method: 'POST', pattern: REPORT_WORKITEM, public: false, handler: ({ req, env, match }) => handleWorkItem(req, env, match[1]!) },
]
