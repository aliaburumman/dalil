// Triage page: GET /r/:id, GET /r/:id/img/:part, POST /r/:id/status.
// Assumed to sit behind Cloudflare Access (README); the Worker has no auth of its own.
import { loadStored, refOf } from './email'
import type { Env, ReportRow } from './env'
import { getProject } from './ingest'
import { AUTO_PART, IMAGE_PART } from './limits'
import { PLAYER_VERSION } from './player-version'
import { failedRequests, failedRequestTitle, kindLabel, relTime, timelineHtml } from './steps'
import { esc, formatTime, partKey } from './util'

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
  return new Response(null, { status: 303, headers: { location: `/r/${id}` } })
}

const CSS = `
:root{--bg:#fff;--fg:#18181b;--muted:#71717a;--card:#f4f4f5;--line:#e4e4e7;--accent:#2563eb;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#f4f4f5;--muted:#a1a1aa;--card:#18181b;--line:#27272a;--accent:#60a5fa;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:13px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px}.chip.k{border-color:var(--accent);color:var(--accent)}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-all;font-size:12px;margin:6px 0}
code{font-size:13px}.shots img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin:6px 0}
ol.tl{padding-left:24px}ol.tl li{margin:2px 0}.t{color:var(--muted);font-size:12px;margin-right:6px;font-variant-numeric:tabular-nums}
.req{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0}.req h3{font-size:15px;margin:0 0 4px;color:var(--bad)}
button,select{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
form.status{display:flex;gap:8px;align-items:center;margin-top:8px}table.kv td{padding:2px 12px 2px 0;vertical-align:top}table.kv td:first-child{color:var(--muted)}
a{color:var(--accent)}.marks{margin:6px 0}.marks button{margin:2px 4px 2px 0}figure{margin:6px 0}`

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
  function done(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1500)}
  function fallback(){var r=document.createRange();r.selectNodeContents(pre);var s=window.getSelection();s.removeAllRanges();s.addRange(r);
    try{document.execCommand('copy');done()}catch(e){b.textContent='Press Ctrl+C'}}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(done,fallback)}else{fallback()}
})});`

export async function handlePage(env: Env, id: string): Promise<Response> {
  const row = await getReport(env, id)
  if (!row) return notFound()
  const project = await getProject(env, row.project_id)
  const ref = project ? refOf(project, row.seq) : `#${row.seq}`
  const stored = await loadStored(env, row)
  const p = stored?.payload
  const nonce = crypto.randomUUID().replace(/-/g, '')

  const h: string[] = []
  h.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`)
  h.push(`<meta name="color-scheme" content="light dark"><title>${esc(ref)} · ${esc(row.title)}</title><style>${CSS}</style>`)
  if (row.has_replay) h.push(`<link rel="stylesheet" href="/assets/rrweb-player.${PLAYER_VERSION}.css">`)
  h.push(`</head><body><main>`)
  h.push(`<div class="meta">${esc(project?.name ?? row.project_id)} · ${esc(ref)}</div>`)
  h.push(`<h1>${esc(row.title)}</h1>`)
  h.push(
    `<div class="chips"><span class="chip k">${esc(kindLabel(row.verdict_kind))}</span><span class="chip">severity: ${esc(row.severity)}</span><span class="chip">status: ${esc(row.status)}</span><span class="chip">email: ${esc(row.email_status)}</span>${row.scrubbed ? '<span class="chip">scrubbed</span>' : ''}</div>`,
  )
  if (row.verdict_headline) h.push(`<p>Likely: <strong>${esc(row.verdict_headline)}</strong>${p?.verdict?.confidence ? ` <span class="meta">(${esc(p.verdict.confidence)} confidence)</span>` : ''}</p>`)
  h.push(
    `<form class="status" method="post" action="/r/${esc(row.id)}/status"><label for="st">Status</label><select id="st" name="status">${STATUSES.map((s) => `<option value="${s}"${s === row.status ? ' selected' : ''}>${s}</option>`).join('')}</select><button type="submit">Update</button></form>`,
  )

  if (!p) {
    h.push(`<p class="meta">The stored report body is missing (expired or not written).</p>`)
  } else {
    const c = p.context ?? {}
    h.push(`<h2>Details</h2><table class="kv">`)
    if (p.expected) h.push(`<tr><td>Expected</td><td>${esc(p.expected)}</td></tr>`)
    h.push(`<tr><td>Who</td><td>${esc([c.userName, c.email, c.role].filter(Boolean).join(' · ') || 'unknown')}</td></tr>`)
    if (c.tenant) h.push(`<tr><td>Tenant</td><td>${esc(c.tenant)}</td></tr>`)
    h.push(`<tr><td>Page</td><td>${esc(p.env?.url)}</td></tr><tr><td>When</td><td>${esc(formatTime(row.created_at))}</td></tr>`)
    if (c.appVersion) h.push(`<tr><td>Version</td><td>${esc(c.appVersion)}</td></tr>`)
    if (p.env) h.push(`<tr><td>Browser</td><td>${esc(p.env.userAgent)} · ${esc(p.env.language)} · ${esc(p.env.timezone)} · ${esc(p.env.viewport?.w)}×${esc(p.env.viewport?.h)}@${esc(p.env.viewport?.dpr)}${p.env.online === false ? ' · offline' : ''}</td></tr>`)
    h.push(`</table>`)

    // Replay first: it is the primary evidence.
    if (row.has_replay) {
      h.push(`<h2 id="replay">Replay</h2><div id="replay-marks" class="marks"></div><div id="replay-box" data-id="${esc(row.id)}" class="meta">Loading recording…</div>`)
    } else if (p.replayError) {
      h.push(`<h2 id="replay">Replay</h2><p class="meta">No recording: ${esc(p.replayError)}</p>`)
    }

    const autoMeta = (p.autoSnaps ?? []).filter((a) => stored.images.some((i) => i.part === a.part))
    if (autoMeta.length) {
      h.push(`<h2>Captured automatically</h2><div class="shots">`)
      for (const a of autoMeta) {
        const n = a.part.replace('auto_', '')
        h.push(`<figure><figcaption class="meta">${esc(formatTime(a.t).slice(11))} · ${esc(a.label)}</figcaption><a href="/r/${esc(row.id)}/auto/${esc(n)}"><img src="/r/${esc(row.id)}/auto/${esc(n)}" alt="${esc(a.label)}"></a></figure>`)
      }
      h.push(`</div>`)
    }

    const imgs = stored.images.filter((i) => i.kind !== 'auto')
    if (imgs.length) {
      h.push(`<h2>Screenshots</h2><div class="shots">`)
      for (const img of imgs) h.push(`<a href="/r/${esc(row.id)}/img/${esc(img.part)}"><img src="/r/${esc(row.id)}/img/${esc(img.part)}" alt="${esc(img.name)}"></a>`)
      h.push(`</div>`)
    } else if (p.screenshotError) {
      h.push(`<p class="meta">No screenshot: ${esc(p.screenshotError)}</p>`)
    }

    const failed = failedRequests(p)
    if (failed.length) {
      h.push(`<h2>Failed requests</h2>`)
      failed.forEach((e, i) => {
        h.push(`<div class="req"><h3>${esc(failedRequestTitle(e))}</h3>`)
        if (e.requestId) h.push(`<div>Request id: <code>${esc(e.requestId)}</code></div>`)
        const curl = p.curls?.[e.id]
        if (curl) h.push(`<pre id="curl-${i}">${esc(curl)}</pre><button type="button" data-copy="curl-${i}">Copy curl</button>`)
        if (e.requestBody) h.push(`<div class="meta">Request body</div><pre>${esc(e.requestBody)}</pre>`)
        if (e.responseBody) h.push(`<div class="meta">Response body</div><pre>${esc(e.responseBody)}</pre>`)
        h.push(`</div>`)
      })
    }

    if (p.events.length) {
      h.push(`<h2>Timeline</h2><ol class="tl">`)
      for (const e of p.events) h.push(`<li><span class="t">${esc(relTime(e.t, p.createdAt))}</span>${timelineHtml(e)}</li>`)
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
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data: https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
    },
  })
}
