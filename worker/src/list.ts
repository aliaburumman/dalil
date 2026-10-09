// Reports list: GET / (all projects) and GET /p/:project. Server-rendered, same CSP approach as page.ts.
// Requires Cloudflare Access: the Access JWT is verified against the team certs (src/access.ts).
import { accessDenied, verifyAccess } from './access'
import { refOf } from './email'
import type { Env, ProjectRow, ReportRow } from './env'
import { kindLabel, KIND_LABEL } from './steps'
import { esc, formatAmman, reporterOf, truncate } from './util'

export const PAGE_SIZE = 50
const STATUS_FILTERS = ['open', 'all', 'new', 'seen', 'fixed', 'wontfix'] as const
const SEVERITY_FILTERS = ['blocker', 'annoying', 'minor'] as const

const CSS = `
:root{--bg:#fff;--fg:#18181b;--muted:#71717a;--card:#f4f4f5;--line:#e4e4e7;--accent:#2563eb;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#f4f4f5;--muted:#a1a1aa;--card:#18181b;--line:#27272a;--accent:#60a5fa;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);font-size:13px}
.filters{display:flex;flex-wrap:wrap;gap:6px 18px;margin:12px 0}.filters div{display:flex;gap:6px;align-items:center}
.filters a{border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:13px;text-decoration:none}.filters a.on{border-color:var(--accent);color:var(--accent);font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top;font-size:13px}th{color:var(--muted);font-weight:500}
a{color:var(--accent)}.sev-blocker{color:var(--bad);font-weight:600}.pager{display:flex;gap:16px;margin:16px 0}`

type Q = { status: string; severity: string; kind: string; page: number }

function parseQuery(sp: URLSearchParams): Q {
  const status = sp.get('status') ?? 'open'
  const severity = sp.get('severity') ?? ''
  const kind = sp.get('kind') ?? ''
  const page = Number.parseInt(sp.get('page') ?? '1', 10)
  return {
    status: (STATUS_FILTERS as readonly string[]).includes(status) ? status : 'open',
    severity: (SEVERITY_FILTERS as readonly string[]).includes(severity) ? severity : '',
    kind: kind in KIND_LABEL ? kind : '',
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
  }
}

function href(base: string, q: Q, over: Partial<Q>): string {
  const n = { ...q, ...over }
  const sp = new URLSearchParams()
  if (n.status !== 'open') sp.set('status', n.status)
  if (n.severity) sp.set('severity', n.severity)
  if (n.kind) sp.set('kind', n.kind)
  if (n.page > 1) sp.set('page', String(n.page))
  const s = sp.toString()
  return s ? `${base}?${s}` : base
}

function chips(label: string, base: string, q: Q, key: 'status' | 'severity' | 'kind', options: readonly [string, string][]): string {
  return `<div><span class="meta">${esc(label)}</span>${options
    .map(([v, text]) => `<a class="${q[key] === v ? 'on' : ''}" href="${esc(href(base, q, { [key]: v, page: 1 }))}">${esc(text)}</a>`)
    .join('')}</div>`
}

export async function handleList(req: Request, env: Env, projectId: string | null): Promise<Response> {
  const user = await verifyAccess(req, env)
  if (!user) return accessDenied()

  const { results: projects } = await env.DB.prepare('SELECT * FROM projects ORDER BY name').all<ProjectRow>()
  const scope = projectId === null ? null : projects.find((p) => p.id === projectId)
  if (projectId !== null && !scope) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  const byId = new Map(projects.map((p) => [p.id, p]))
  const q = parseQuery(new URL(req.url).searchParams)
  const base = scope ? `/p/${encodeURIComponent(scope.id)}` : '/'

  const where: string[] = []
  const binds: (string | number)[] = []
  if (scope) {
    where.push('project_id = ?')
    binds.push(scope.id)
  }
  if (q.status === 'open') where.push(`status IN ('new','seen')`)
  else if (q.status !== 'all') {
    where.push('status = ?')
    binds.push(q.status)
  }
  if (q.severity) {
    where.push('severity = ?')
    binds.push(q.severity)
  }
  if (q.kind) {
    where.push('verdict_kind = ?')
    binds.push(q.kind)
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports ${cond}`).bind(...binds).first<{ n: number }>())?.n ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(q.page, pages)
  const { results: rows } = await env.DB.prepare(`SELECT * FROM reports ${cond} ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all<ReportRow>()

  // Header counts ignore the status/severity/kind filters but respect the project scope.
  const scopeSql = scope ? 'WHERE project_id = ?' : ''
  const { results: counts } = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM reports ${scopeSql} GROUP BY status`)
    .bind(...(scope ? [scope.id] : []))
    .all<{ status: string; n: number }>()
  const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0

  const title = scope ? scope.name : 'All projects'
  const h: string[] = []
  h.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Reports · ${esc(title)}</title><style>${CSS}</style></head><body><main>`)
  h.push(`<h1>${esc(title)}</h1>`)
  h.push(`<div class="meta">Signed in as ${esc(user.email)}</div>`)
  h.push(`<div class="meta">${count('new')} new · ${count('seen')} seen · ${count('fixed')} fixed · ${count('wontfix')} won't fix${scope ? '' : ` · ${projects.map((p) => `<a href="/p/${esc(encodeURIComponent(p.id))}">${esc(p.name)}</a>`).join(' · ')}`}</div>`)
  h.push(`<div class="filters">`)
  h.push(chips('Status', base, q, 'status', STATUS_FILTERS.map((s) => [s, s === 'wontfix' ? "won't fix" : s] as [string, string])))
  h.push(chips('Severity', base, q, 'severity', [['', 'any'], ...SEVERITY_FILTERS.map((s) => [s, s] as [string, string])]))
  h.push(chips('Kind', base, q, 'kind', [['', 'any'], ...Object.entries(KIND_LABEL)]))
  h.push(`</div>`)
  h.push(`<div class="meta">${total} report${total === 1 ? '' : 's'} · page ${page} of ${pages}</div>`)

  if (rows.length === 0) {
    h.push(`<p class="meta">No reports match.</p>`)
  } else {
    h.push(`<table><thead><tr><th>Ref</th><th>When (Amman)</th><th>Severity</th><th>Verdict</th><th>Title</th><th>Reporter</th><th>Rec</th><th>Auto</th><th>Status</th></tr></thead><tbody>`)
    for (const r of rows) {
      const proj = byId.get(r.project_id)
      const ref = proj ? refOf(proj, r.seq) : `#${r.seq}`
      const who = reporterOf(r.reporter)
      const link = `/r/${esc(r.id)}`
      h.push(
        `<tr><td><a href="${link}">${esc(ref)}</a></td><td>${esc(formatAmman(r.created_at))}</td><td class="sev-${esc(r.severity)}">${esc(r.severity)}</td><td><strong>${esc(kindLabel(r.verdict_kind))}</strong> ${esc(r.verdict_headline ?? '')}</td><td><a href="${link}">${esc(truncate(r.title, 100))}</a></td><td>${esc([who.name, who.tenant].filter(Boolean).join(' · '))}</td><td>${r.has_replay ? 'yes' : ''}</td><td>${r.auto_snaps || ''}</td><td>${esc(r.status)}</td></tr>`,
      )
    }
    h.push(`</tbody></table>`)
  }
  h.push(`<div class="pager">${page > 1 ? `<a href="${esc(href(base, q, { page: page - 1 }))}">Newer</a>` : ''}${page < pages ? `<a href="${esc(href(base, q, { page: page + 1 }))}">Older</a>` : ''}</div>`)
  h.push(`</main></body></html>`)

  return new Response(h.join(''), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
    },
  })
}
