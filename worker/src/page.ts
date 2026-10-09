// Triage page: GET /r/:id, GET /r/:id/img/:part, POST /r/:id/status.
// Assumed to sit behind Cloudflare Access (README); the Worker has no auth of its own.
import { accessDenied, verifyAccess } from './access'
import { loadStored, refOf } from './email'
import type { Env, ReportRow } from './env'
import { getProject } from './ingest'
import { AUTO_PART, IMAGE_PART } from './limits'
import { PLAYER_VERSION } from './player-version'
import type { ProjectRow } from './env'
import { failedRequests, failedRequestTitle, isFailedRequest, kindLabel, relTime, timelineHtml } from './steps'
import { BASE_CSS, htmlHeaders, icon, KIND_COLOR, relAgo, safeNext, SEV_LABEL, statusLabel, topbar } from './ui'
import { esc, formatAmman, formatTime, partKey } from './util'

export const STATUSES = ['new', 'seen', 'fixed', 'wontfix'] as const
const ID = /^[0-9a-f-]{36}$/

async function getReport(env: Env, id: string): Promise<ReportRow | null> {
  if (!ID.test(id)) return null
  return env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>()
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })

export async function handleImage(env: Env, id: string, part: string): Promise<Response> {
  if (!IMAGE_PART.test(part)) return notFound()
  const row = await getReport(env, id)
  if (!row) return notFound()
  const obj = await env.BUCKET.get(`${row.r2_prefix}${part}`)
  if (!obj) return notFound()
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      'content-security-policy': "default-src 'none'",
    },
  })
}

export async function handleAuto(env: Env, id: string, n: string): Promise<Response> {
  const part = `auto_${n}`
  if (!AUTO_PART.test(part)) return notFound()
  const row = await getReport(env, id)
  if (!row) return notFound()
  const obj = await env.BUCKET.get(`${row.r2_prefix}${partKey(part)}`)
  if (!obj) return notFound()
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      'content-security-policy': "default-src 'none'",
    },
  })
}

/** The gzip is streamed as stored; the browser decompresses it (DecompressionStream). */
export async function handleReplay(env: Env, id: string): Promise<Response> {
  const row = await getReport(env, id)
  if (!row || !row.has_replay) return notFound()
  const obj = await env.BUCKET.get(`${row.r2_prefix}replay.json.gz`)
  if (!obj) return notFound()
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/gzip',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'",
    },
  })
}

export async function handleStatus(req: Request, env: Env, id: string): Promise<Response> {
  // Same-origin check: a cheap CSRF guard on top of Access.
  if (!(await verifyAccess(req, env))) return accessDenied()
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(req.url).origin) return new Response('Forbidden', { status: 403 })
  const row = await getReport(env, id)
  if (!row) return notFound()
  const form = await req.formData().catch(() => null)
  const status = form?.get('status')
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    return new Response('Invalid status', { status: 400 })
  }
  await env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(status, id).run()
  return new Response(null, { status: 303, headers: { location: safeNext(form?.get('next'), `/r/${id}`) } })
}

const CSS = `
.crumb{font-size:12.5px;margin-bottom:10px}.crumb a{color:var(--muted);text-decoration:none}.crumb a:hover{color:var(--accent)}
.head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.head .l{min-width:0;flex:1 1 420px}
.refline{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
.refline .ref{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700}
h1{font-size:24px;line-height:1.25;margin:8px 0 10px;letter-spacing:-.01em;overflow-wrap:anywhere}
.verdict{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.verdict .hl{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.statusform{display:flex;gap:8px;align-items:center}
.statusform select{font:inherit;font-size:13px;padding:5px 8px;border-radius:7px;border:1px solid var(--line);background:var(--surface);color:var(--fg)}
.saw{margin:14px 0 0;padding:10px 14px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;background:var(--surface);overflow-wrap:anywhere}
.saw small{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.saw.exp{border-left-color:var(--line)}
h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:30px 0 10px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:18px}
.grid div{background:var(--surface);padding:9px 12px;min-width:0;overflow-wrap:anywhere}
.grid div.w{grid-column:1/-1}
.grid small{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.grid .mono{font-size:12.5px}
.shot{display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow)}
.shot img{display:block;width:100%;height:auto}
.strip{display:flex;gap:10px;margin-top:10px;overflow-x:auto;padding-bottom:4px}
.strip figure{margin:0;flex:none;width:200px}
.strip a{display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface)}
.strip img{display:block;width:100%;height:125px;object-fit:cover}
.strip figcaption{font-size:12px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.strip figcaption b{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:500;color:var(--fg);margin-right:6px}
#replay-box{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--surface);overflow:auto;color:var(--muted)}
.marks{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px;color:var(--muted);font-size:12.5px}
.marks:empty{display:none}
.marks button{font:inherit;font-size:12.5px;padding:2px 10px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer}
.marks button:hover{background:var(--accent-soft);color:var(--accent);border-color:transparent}
ol.tl{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
ol.tl li{display:grid;grid-template-columns:22px 62px minmax(0,1fr);gap:8px;align-items:start;padding:7px 12px;border-top:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
ol.tl li:first-child{border-top:0}
ol.tl .ic{color:var(--muted);padding-top:2px}
ol.tl .t{color:var(--muted);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;padding-top:1px}
ol.tl li.bad{background:var(--bad-soft)}ol.tl li.bad .ic{color:var(--blocker)}
ol.tl code{font-size:12.5px}
.req{border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:12px 14px;margin-bottom:10px;border-left:3px solid var(--blocker)}
.req h3{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;margin:0 0 8px;overflow-wrap:anywhere}
.rid{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-bottom:8px}
.rid code{color:var(--fg)}
pre{background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;font-size:12px;margin:6px 0;max-height:360px;overflow:auto}
details{margin-top:6px}summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted)}
.lbl{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);margin-top:6px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
@media (max-width:720px){.grid{grid-template-columns:1fr 1fr}h1{font-size:20px}ol.tl li{grid-template-columns:20px 54px minmax(0,1fr);padding:7px 10px}.strip figure{width:160px}.strip img{height:100px}}
@media (max-width:420px){.grid{grid-template-columns:1fr}}`

const REPLAY_JS = `
(function(){
  var box=document.getElementById('replay-box');if(!box)return;
  var id=box.getAttribute('data-id');
  function msg(t){box.textContent=t}
  function flat(d){
    if(d&&!Array.isArray(d)&&Array.isArray(d.events))d=d.events;
    if(!Array.isArray(d))return [];
    var out=[];d.forEach(function(x){if(Array.isArray(x))out=out.concat(flat(x));else if(x&&typeof x==='object')out.push(x)});return out
  }
  if(typeof DecompressionStream==='undefined'){msg('This browser cannot decompress the recording (no DecompressionStream).');return}
  var P=window.rrwebPlayer;P=P&&P.default?P.default:P;
  if(!P){msg('The player failed to load.');return}
  fetch('/r/'+id+'/replay',{credentials:'same-origin'}).then(function(r){
    if(!r.ok)throw new Error('HTTP '+r.status);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text()
  }).then(function(text){
    var events=flat(JSON.parse(text)).sort(function(a,b){return a.timestamp-b.timestamp});
    if(events.length<2)throw new Error('recording has too few events');
    var first=events[0].timestamp;box.textContent='';
    var width=Math.min(box.clientWidth||900,940);
    var player=new P({target:box,props:{events:events,width:width,height:Math.round(width*0.6),autoPlay:false,showController:true}});
    var marks=events.filter(function(e){return e.type===5&&e.data&&e.data.tag==='dalil'});
    if(marks.length){
      var bar=document.getElementById('replay-marks');bar.textContent='Jump to: ';
      marks.forEach(function(e){
        var pl=e.data.payload||{};var b=document.createElement('button');b.type='button';
        var secs=Math.max(0,Math.round((e.timestamp-first)/1000));
        b.textContent=String(pl.label||pl.kind||'event')+' ('+Math.floor(secs/60)+':'+('0'+(secs%60)).slice(-2)+')';
        b.addEventListener('click',function(){player.goto(Math.max(0,e.timestamp-first-1500),true)});
        bar.appendChild(b);bar.appendChild(document.createTextNode(' '));
      });
    }
  }).catch(function(e){msg('Could not load the recording: '+(e&&e.message?e.message:e))});
})();`

const JS = `
document.querySelectorAll('button[data-copy]').forEach(function(b){b.addEventListener('click',function(){
  var pre=document.getElementById(b.getAttribute('data-copy'));if(!pre)return;var text=pre.textContent||'';
  function done(){var o=b.innerHTML;b.textContent='Copied';setTimeout(function(){b.innerHTML=o},1500)}
  function fallback(){var r=document.createRange();r.selectNodeContents(pre);var s=window.getSelection();s.removeAllRanges();s.addRange(r);
    try{document.execCommand('copy');done()}catch(e){b.textContent='Press Ctrl+C'}}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(done,fallback)}else{fallback()}
})});`

const TL_ICON: Record<string, string> = { nav: 'nav', click: 'click', input: 'input', submit: 'submit', request: 'req', error: 'err', log: 'log' }

export async function handlePage(env: Env, id: string, req?: Request): Promise<Response> {
  const row = await getReport(env, id)
  if (!row) return notFound()
  const project = await getProject(env, row.project_id)
  const ref = project ? refOf(project, row.seq) : `#${row.seq}`
  const stored = await loadStored(env, row)
  const p = stored?.payload
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const user = req ? await verifyAccess(req, env) : null
  const { results: projects } = await env.DB.prepare('SELECT * FROM projects ORDER BY name').all<ProjectRow>()
  const now = Date.now()
  const sev = row.severity ?? 'minor'
  const kc = KIND_COLOR[row.verdict_kind ?? ''] ?? '#64748b'
  const listHref = `/p/${encodeURIComponent(row.project_id)}`

  const h: string[] = []
  h.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`)
  h.push(`<meta name="color-scheme" content="light dark"><title>${esc(ref)} · ${esc(row.title)}</title><style>${BASE_CSS}${CSS}</style>`)
  if (row.has_replay) h.push(`<link rel="stylesheet" href="/assets/rrweb-player.${PLAYER_VERSION}.css">`)
  h.push(`</head><body>`)
  h.push(topbar(projects, row.project_id, user?.email ?? null))
  h.push(`<main>`)
  h.push(`<div class="crumb"><a href="${esc(listHref)}">&larr; ${esc(project?.name ?? row.project_id)} reports</a></div>`)
  h.push(`<div class="head"><div class="l"><div class="refline"><span class="ref">${esc(ref)}</span><span class="pill ${esc(row.status)}">${esc(statusLabel(row.status))}</span><span class="sev ${esc(sev)}">${esc(SEV_LABEL[sev] ?? sev)}</span>${row.scrubbed ? '<span class="pill">scrubbed</span>' : ''}<span class="pill" title="Email status">email: ${esc(row.email_status)}</span></div>`)
  h.push(`<h1>${esc(row.title)}</h1>`)
  h.push(`<div class="verdict"><span class="kind" style="--kc:${kc}">${esc(kindLabel(row.verdict_kind))}</span>${row.verdict_headline ? `<span class="hl">${esc(row.verdict_headline)}</span>` : ''}${p?.verdict?.confidence ? `<span class="muted" style="font-size:12px">${esc(p.verdict.confidence)} confidence</span>` : ''}</div></div>`)
  h.push(
    `<form class="statusform" method="post" action="/r/${esc(row.id)}/status"><label class="muted" for="st" style="font-size:12.5px">Status</label><select id="st" name="status">${STATUSES.map((s) => `<option value="${s}"${s === row.status ? ' selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select><button class="btn primary" type="submit">Update</button></form></div>`,
  )
  if (p?.verdict?.userSaw) h.push(`<div class="saw"><small>User saw</small>&quot;${esc(p.verdict.userSaw)}&quot;</div>`)

  if (!p) {
    h.push(`<p class="muted">The stored report body is missing (expired or not written).</p>`)
  } else {
    const c = p.context ?? {}
    const cell = (label: string, value: string, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><small>${esc(label)}</small>${value}</div>`
    const cells: string[] = []
    cells.push(cell('Reporter', esc([c.userName, c.email, c.role].filter(Boolean).join(' · ') || 'unknown')))
    cells.push(cell('Tenant', esc(c.tenant || '-')))
    cells.push(cell('Version', esc(c.appVersion || '-')))
    cells.push(cell('Page', `<span class="mono">${esc(p.env?.url)}</span>`, 'w'))
    cells.push(cell('When', `<span title="${esc(formatTime(row.created_at))}">${esc(formatAmman(row.created_at))} (Amman) · ${esc(relAgo(row.created_at, now))}</span>`, 'w'))
    if (p.env) cells.push(cell('Browser', `${esc(p.env.userAgent)} · ${esc(p.env.language)} · ${esc(p.env.timezone)} · ${esc(p.env.viewport?.w)}×${esc(p.env.viewport?.h)}@${esc(p.env.viewport?.dpr)}${p.env.online === false ? ' · offline' : ''}`, 'w'))
    h.push(`<section class="grid">${cells.join('')}</section>`)
    if (p.expected) h.push(`<div class="saw exp"><small>Expected</small>${esc(p.expected)}</div>`)

    const imgs = stored.images.filter((i) => i.kind !== 'auto')
    const autoMeta = (p.autoSnaps ?? []).filter((a) => stored.images.some((i) => i.part === a.part))
    if (imgs.length || autoMeta.length || p.screenshotError) {
      h.push(`<h2>Screenshot</h2>`)
      for (const img of imgs) h.push(`<a class="shot" href="/r/${esc(row.id)}/img/${esc(img.part)}" target="_blank" rel="noopener"><img src="/r/${esc(row.id)}/img/${esc(img.part)}" alt="${esc(img.name)}"></a>`)
      if (!imgs.length && p.screenshotError) h.push(`<p class="muted">No screenshot: ${esc(p.screenshotError)}</p>`)
      if (autoMeta.length) {
        h.push(`<h2>Captured automatically</h2><div class="strip">`)
        for (const a of autoMeta) {
          const n = a.part.replace('auto_', '')
          h.push(`<figure><a href="/r/${esc(row.id)}/auto/${esc(n)}" target="_blank" rel="noopener"><img src="/r/${esc(row.id)}/auto/${esc(n)}" alt="${esc(a.label)}" loading="lazy"></a><figcaption title="${esc(a.label)}"><b>${esc(formatTime(a.t).slice(11, 19))}</b>${esc(a.label)}</figcaption></figure>`)
        }
        h.push(`</div>`)
      }
    }

    if (row.has_replay) {
      h.push(`<h2 id="replay">Replay</h2><div id="replay-marks" class="marks"></div><div id="replay-box" data-id="${esc(row.id)}">Loading recording…</div>`)
    } else if (p.replayError) {
      h.push(`<h2 id="replay">Replay</h2><p class="muted">No recording: ${esc(p.replayError)}</p>`)
    }

    const failed = failedRequests(p)
    if (failed.length) {
      h.push(`<h2>Failed requests</h2>`)
      failed.forEach((e, i) => {
        h.push(`<div class="req"><h3>${esc(failedRequestTitle(e))}</h3>`)
        if (e.requestId) h.push(`<div class="rid">Request id <code id="rid-${i}">${esc(e.requestId)}</code><button class="btn" type="button" data-copy="rid-${i}">${icon('copy')} Copy</button></div>`)
        const curl = p.curls?.[e.id]
        if (curl) h.push(`<div class="lbl"><span>curl</span><button class="btn" type="button" data-copy="curl-${i}">${icon('copy')} Copy curl</button></div><pre id="curl-${i}">${esc(curl)}</pre>`)
        if (e.requestBody) h.push(`<details><summary>Request body</summary><pre>${esc(e.requestBody)}</pre></details>`)
        if (e.responseBody) h.push(`<details><summary>Response body</summary><pre>${esc(e.responseBody)}</pre></details>`)
        h.push(`</div>`)
      })
    }

    if (p.events.length) {
      h.push(`<h2>Timeline</h2><ol class="tl">`)
      for (const e of p.events) {
        const bad = isFailedRequest(e) || e.type === 'error'
        h.push(`<li${bad ? ' class="bad"' : ''}><span class="ic">${icon(TL_ICON[e.type] ?? 'log')}</span><span class="t">${esc(relTime(e.t, p.createdAt))}</span><span>${timelineHtml(e)}</span></li>`)
      }
      h.push(`</ol>`)
    }

    const errors = p.events.filter((e) => e.type === 'error')
    if (errors.length) {
      h.push(`<h2>Errors</h2>`)
      for (const e of errors) if (e.type === 'error') h.push(`<pre>${esc(e.message)}${e.stack ? `\n${esc(e.stack)}` : ''}</pre>`)
    }
  }

  h.push(`</main>`)
  if (row.has_replay) h.push(`<script src="/assets/rrweb-player.${PLAYER_VERSION}.js" nonce="${nonce}"></script><script nonce="${nonce}">${REPLAY_JS}</script>`)
  h.push(`<script nonce="${nonce}">${JS}</script></body></html>`)
  return new Response(h.join(''), {
    headers: htmlHeaders(`default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data: https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`),
  })
}
