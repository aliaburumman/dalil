// Reports list: GET / (all projects) and GET /p/:project. Server-rendered, same CSP approach as page.ts.
// Requires Cloudflare Access: the Access JWT is verified against the team certs (src/access.ts).
import { accessDenied, verifyAccess } from './access'
import { refOf } from './email'
import type { Env, ProjectRow, ReportRow } from './env'
import { kindLabel, KIND_LABEL } from './steps'
import { KIND_COLOR, BASE_CSS, htmlHeaders, icon, relAgo, SEV_LABEL, statusLabel, topbar } from './ui'
import { esc, formatAmman, pathOf, reporterOf, truncate } from './util'

const ammanDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(new Date(ms))
const dayLabel = (ms: number, now: number) => {
  const d = ammanDay(ms)
  if (d === ammanDay(now)) return 'Today'
  if (d === ammanDay(now - 86_400_000)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(ms))
}

export const PAGE_SIZE = 50
const STATUS_FILTERS = ['open', 'all', 'new', 'seen', 'fixed', 'wontfix'] as const
const SEVERITY_FILTERS = ['blocker', 'annoying', 'minor'] as const

const CSS = `
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 14px;box-shadow:var(--shadow);min-width:0}
.stat .l{font-size:11.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.stat .n{font-size:24px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}
.stat .n.bad{color:var(--blocker)}
.stat .split{display:flex;gap:10px;align-items:baseline;font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .split small{font-size:10.5px;font-weight:600;color:var(--muted);display:block;letter-spacing:.03em}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{padding:8px 12px;color:var(--muted);text-decoration:none;font-weight:600;font-size:13.5px;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--fg)}
.tabs a.on{color:var(--accent);border-bottom-color:var(--accent)}
.tabs a b{font-weight:500;font-size:12px;margin-left:5px;opacity:.75;font-variant-numeric:tabular-nums}
.chiprow{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;padding:12px 0 4px}
.chiprow::-webkit-scrollbar{display:none}
.chiprow .sep{width:1px;height:18px;background:var(--line);flex:none;margin:0 4px}
.chiprow a{flex:none;padding:2px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);text-decoration:none;font-size:12.5px;font-weight:500}
.chiprow a:hover{color:var(--fg)}
.chiprow a.on{background:var(--accent-soft);border-color:transparent;color:var(--accent);font-weight:700}
.count{color:var(--muted);font-size:12.5px;padding:6px 0 0}
.day{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:22px 2px 8px}
.card{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px 14px;align-items:center;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--minor);border-radius:10px;padding:12px 14px;margin-bottom:8px;box-shadow:var(--shadow)}
.card:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));border-left-color:var(--minor)}
.card.blocker{border-left-color:var(--blocker)}.card.annoying{border-left-color:var(--annoying)}
.thumb{grid-column:1;width:112px;height:70px;border-radius:7px;border:1px solid var(--line);overflow:hidden;background:var(--surface2)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.body{grid-column:2;min-width:0}
.act{grid-column:3}
.card.nothumb{grid-template-columns:minmax(0,1fr) auto}.card.nothumb .thumb{display:none}.card.nothumb .body{grid-column:1}.card.nothumb .act{grid-column:2}
.title{display:block;font-weight:650;font-size:15px;color:var(--fg);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title::after{content:"";position:absolute;inset:0;border-radius:10px}
.l2{display:flex;gap:8px;align-items:center;margin-top:3px;min-width:0}
.hl{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.saw{font-size:12.5px;font-style:italic;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:center;font-size:12px;color:var(--muted);margin-top:4px}
.meta .ref{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600;color:var(--fg)}
.meta span{display:inline-flex;align-items:center;gap:3px;min-width:0}
.meta .pg{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
.act{position:relative;z-index:2;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.act .btns{display:flex;gap:6px}
.act form{margin:0}
.empty{text-align:center;padding:56px 16px;color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:10px;margin-top:18px}
.empty b{display:block;color:var(--fg);font-size:15px;margin-bottom:4px}
.pager{display:flex;gap:10px;margin:18px 0}
.pager a{padding:5px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);text-decoration:none;font-weight:600;font-size:13px}
@media (max-width:720px){
.stats{grid-template-columns:repeat(2,1fr)}
.card{grid-template-columns:auto minmax(0,1fr);padding:10px 12px}
.thumb{width:72px;height:48px}
.card.nothumb{grid-template-columns:minmax(0,1fr)}.act,.card.nothumb .act{grid-column:1/-1;flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap}
.meta .pg{max-width:160px}
.title{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
}`

const JS = `
document.addEventListener('error',function(e){var t=e.target;if(t&&t.tagName==='IMG'&&t.closest&&t.closest('.thumb')){t.closest('.card').classList.add('nothumb')}},true);
document.querySelectorAll('.thumb img').forEach(function(i){if(i.complete&&i.naturalWidth===0)i.closest('.card').classList.add('nothumb')});`

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

function chipLinks(base: string, q: Q, key: 'severity' | 'kind', options: readonly [string, string][]): string {
  return options.map(([v, text]) => `<a class="${q[key] === v ? 'on' : ''}" href="${esc(href(base, q, { [key]: v, page: 1 }))}">${esc(text)}</a>`).join('')
}

function card(r: ReportRow, ref: string, now: number, back: string): string {
  const who = reporterOf(r.reporter)
  const link = `/r/${esc(r.id)}`
  const sev = r.severity ?? 'minor'
  const thumb = r.auto_snaps > 0 ? `${link}/auto/0` : `${link}/img/image_0`
  const kc = KIND_COLOR[r.verdict_kind ?? ''] ?? '#64748b'
  let page = ''
  if (r.page_url) page = pathOf(r.page_url)
  const btn = (to: string, text: string) =>
    r.status === to
      ? ''
      : `<form method="post" action="${link}/status"><input type="hidden" name="status" value="${to}"><input type="hidden" name="next" value="${esc(back)}"><button class="btn" type="submit">${text}</button></form>`
  const bits = [
    `<span class="ref">${esc(ref)}</span>`,
    `<span title="${esc(formatAmman(r.created_at))} (Asia/Amman)">${esc(relAgo(r.created_at, now))}</span>`,
    who.name ? `<span>${esc(who.name)}</span>` : '',
    who.tenant ? `<span>${esc(who.tenant)}</span>` : '',
    page ? `<span class="pg" title="${esc(page)}">${esc(truncate(page, 80))}</span>` : '',
    r.has_replay ? `<span title="Has a recording">${icon('rec')}rec</span>` : '',
    r.auto_snaps ? `<span title="${r.auto_snaps} automatic snapshot${r.auto_snaps === 1 ? '' : 's'}">${icon('cam')}${r.auto_snaps}</span>` : '',
  ].filter(Boolean)
  return `<article class="card ${esc(sev)}"><div class="thumb"><img src="${thumb}" alt="" loading="lazy"></div><div class="body"><a class="title" href="${link}">${esc(truncate(r.title, 140))}</a><div class="l2"><span class="kind" style="--kc:${kc}">${esc(kindLabel(r.verdict_kind))}</span><span class="hl mono">${esc(r.verdict_headline ?? '')}</span></div>${r.user_saw ? `<div class="saw">User saw: &quot;${esc(truncate(r.user_saw, 160))}&quot;</div>` : ''}<div class="meta">${bits.join('<i class="muted">·</i>')}</div></div><div class="act"><span class="pill ${esc(r.status)}">${esc(statusLabel(r.status))}</span><div class="btns">${btn('seen', 'Seen')}${btn('fixed', 'Fixed')}</div></div></article>`
}

export async function handleList(req: Request, env: Env, projectId: string | null): Promise<Response> {
  const user = await verifyAccess(req, env)
  if (!user) return accessDenied()

  const { results: projects } = await env.DB.prepare('SELECT * FROM projects ORDER BY name').all<ProjectRow>()
  const scope = projectId === null ? null : projects.find((p) => p.id === projectId)
  if (projectId !== null && !scope) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  const byId = new Map(projects.map((p) => [p.id, p]))
  const url = new URL(req.url)
  const q = parseQuery(url.searchParams)
  const base = scope ? `/p/${encodeURIComponent(scope.id)}` : '/'
  const now = Date.now()

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

  // Counts ignore the status/severity/kind filters but respect the project scope.
  const scopeSql = scope ? 'WHERE project_id = ?' : ''
  const scopeBind = scope ? [scope.id] : []
  const { results: counts } = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM reports ${scopeSql} GROUP BY status`)
    .bind(...scopeBind)
    .all<{ status: string; n: number }>()
  const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0
  const openN = count('new') + count('seen')
  const allN = counts.reduce((a, c) => a + c.n, 0)
  const st =
    (await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('new','seen') AND severity = 'blocker' THEN 1 ELSE 0 END) AS blockers,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24,
         SUM(CASE WHEN status IN ('new','seen') AND verdict_kind = 'backend' THEN 1 ELSE 0 END) AS be,
         SUM(CASE WHEN status IN ('new','seen') AND verdict_kind IN ('frontend','ux','validation') THEN 1 ELSE 0 END) AS fe,
         SUM(CASE WHEN status IN ('new','seen') AND (verdict_kind IS NULL OR verdict_kind IN ('network','permission')) THEN 1 ELSE 0 END) AS other
       FROM reports ${scopeSql}`,
    )
      .bind(now - 86_400_000, ...scopeBind)
      .first<{ blockers: number | null; last24: number | null; be: number | null; fe: number | null; other: number | null }>()) ?? { blockers: 0, last24: 0, be: 0, fe: 0, other: 0 }

  const title = scope ? scope.name : 'All projects'
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const back = url.pathname + url.search
  const tabCounts: Record<string, number> = { open: openN, new: count('new'), seen: count('seen'), fixed: count('fixed'), wontfix: count('wontfix'), all: allN }
  const tabOrder = ['open', 'new', 'seen', 'fixed', 'wontfix', 'all']

  const h: string[] = []
  h.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Reports · ${esc(title)}</title><style>${BASE_CSS}${CSS}</style></head><body>`)
  h.push(topbar(projects, scope ? scope.id : null, user.email))
  h.push(`<main>`)
  h.push(`<section class="stats" aria-label="Summary"><div class="stat"><div class="l">Open</div><div class="n">${openN}</div></div><div class="stat"><div class="l">Blockers</div><div class="n${st.blockers ? ' bad' : ''}">${st.blockers ?? 0}</div></div><div class="stat"><div class="l">Last 24h</div><div class="n">${st.last24 ?? 0}</div></div><div class="stat"><div class="l">Open by area</div><div class="split"><span>${st.be ?? 0}<small>Backend</small></span><span>${st.fe ?? 0}<small>Frontend</small></span><span>${st.other ?? 0}<small>Other</small></span></div></div></section>`)
  h.push(`<nav class="tabs" aria-label="Status">${tabOrder.map((s) => `<a class="${q.status === s ? 'on' : ''}" href="${esc(href(base, q, { status: s, page: 1 }))}">${esc(s === 'open' ? 'Open' : s === 'all' ? 'All' : statusLabel(s))}<b>${tabCounts[s] ?? 0}</b></a>`).join('')}</nav>`)
  h.push(
    `<div class="chiprow">${chipLinks(base, q, 'severity', [['', 'Any severity'], ...(['blocker', 'annoying', 'minor'] as const).map((s) => [s, SEV_LABEL[s]!] as [string, string])])}<span class="sep"></span>${chipLinks(base, q, 'kind', [['', 'Any kind'], ...Object.entries(KIND_LABEL)])}</div>`,
  )
  h.push(`<div class="count">${total} report${total === 1 ? '' : 's'}${pages > 1 ? ` · page ${page} of ${pages}` : ''}</div>`)

  if (rows.length === 0) {
    h.push(`<div class="empty"><b>No reports here yet</b>Reports from the bug button appear here.</div>`)
  } else {
    let lastDay = ''
    for (const r of rows) {
      const d = ammanDay(r.created_at)
      if (d !== lastDay) {
        h.push(`<h2 class="day">${esc(dayLabel(r.created_at, now))}</h2>`)
        lastDay = d
      }
      const proj = byId.get(r.project_id)
      h.push(card(r, proj ? refOf(proj, r.seq) : `#${r.seq}`, now, back))
    }
  }
  h.push(`<div class="pager">${page > 1 ? `<a href="${esc(href(base, q, { page: page - 1 }))}">Newer</a>` : ''}${page < pages ? `<a href="${esc(href(base, q, { page: page + 1 }))}">Older</a>` : ''}</div>`)
  h.push(`</main><script nonce="${nonce}">${JS}</script></body></html>`)

  return new Response(h.join(''), {
    headers: htmlHeaders(`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`),
  })
}
