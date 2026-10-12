// Lazy chunk: builds a self-contained replay HTML file (player JS + CSS inline, the recording as
// base64 of the existing gzip) that plays offline from a Bug attachment. No server involved.
import { adoFetch, getScriptUrl } from '../core/adoFetch'

export const PLAYER_VERSION = '2.1.7'
const JS_NAME = `rrweb-player.${PLAYER_VERSION}.js`
const CSS_NAME = `rrweb-player.${PLAYER_VERSION}.css`
/** Seconds of lead before the failure when the file opens. */
export const FAILURE_LEAD_MS = 5000

/**
 * Which dalil marker to open at: the one matching the verdict's evidence event, else the first
 * request/error marker, else the first marker, else null. Source text (also run in tests).
 */
export const PICK_TARGET_JS = `function pickTarget(marks,ev){
  function pl(e){return (e&&e.data&&e.data.payload)||{}}
  var i;
  if(ev)for(i=0;i<marks.length;i++)if(pl(marks[i]).eventId===ev)return marks[i];
  for(i=0;i<marks.length;i++){var k=pl(marks[i]).kind;if(k==='request'||k==='error')return marks[i]}
  return marks.length?marks[0]:null
}`

export interface PlayerAssets {
  js: string
  css: string
}

let cached: { key: string; assets: PlayerAssets } | null = null

function candidates(playerUrl?: string): string[] {
  const out: string[] = []
  if (playerUrl) out.push(playerUrl.endsWith('/') ? playerUrl : `${playerUrl}/`)
  try {
    // ESM builds: the chunk sits in dist/, assets in dist/assets/.
    const metaUrl = (import.meta as { url?: string }).url
    if (metaUrl) out.push(new URL('./assets/', metaUrl).href)
  } catch {
    /* IIFE build: import.meta is empty */
  }
  const script = getScriptUrl()
  if (script) {
    try {
      out.push(new URL('./assets/', script).href)
    } catch {
      /* ignore */
    }
  }
  return out
}

async function getText(url: string): Promise<string> {
  const res = await adoFetch()(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (!text) throw new Error('empty')
  return text
}

/** Player JS + CSS text via the original fetch, or null when none of the locations works (CSP, offline). */
export async function loadPlayerAssets(playerUrl?: string): Promise<PlayerAssets | null> {
  for (const base of candidates(playerUrl)) {
    if (cached?.key === base) return cached.assets
    try {
      const [js, css] = await Promise.all([getText(new URL(JS_NAME, base).href), getText(new URL(CSS_NAME, base).href)])
      cached = { key: base, assets: { js, css } }
      return cached.assets
    } catch {
      /* try the next location */
    }
  }
  return null
}

/** Test hook. */
export function __resetPlayerCacheForTests(): void {
  cached = null
}

/** Keeps inline script/style text from ending its element early. */
function inertScript(s: string): string {
  return s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}
function inertStyle(s: string): string {
  return s.replace(/<\/(style)/gi, '<\\/$1')
}
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const PAGE_JS = `
${PICK_TARGET_JS}
(function(){
  var box=document.getElementById('replay-box');
  function msg(t){box.textContent=t}
  function flat(d){
    if(d&&!Array.isArray(d)&&Array.isArray(d.events))d=d.events;
    if(!Array.isArray(d))return [];
    var out=[];d.forEach(function(x){if(Array.isArray(x))out=out.concat(flat(x));else if(x&&typeof x==='object')out.push(x)});return out
  }
  if(typeof DecompressionStream==='undefined'){msg('This browser cannot decompress the recording (no DecompressionStream).');return}
  var P=window.rrwebPlayer;P=P&&P.default?P.default:P;
  if(!P){msg('The player failed to load.');return}
  var bin=atob(document.getElementById('rec').textContent.trim());
  var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text().then(function(text){
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
    var tg=pickTarget(marks,box.getAttribute('data-evidence')||'');
    var from=tg?Math.max(0,tg.timestamp-first-FAILURE_LEAD_MS):0;
    player.goto(from,true);
    box.setAttribute('data-played-from',String(from));
  }).catch(function(e){msg('Could not load the recording: '+(e&&e.message?e.message:e))});
})();`

export interface PortableReplayInput {
  /** the gzip the collector path would upload (rrweb events JSON) */
  gz: Blob
  title: string
  durationMs: number
  /** verdict.evidenceEventId */
  evidenceId?: string
  assets: PlayerAssets
}

/** The replay HTML as a Blob. Pure given the assets: tests pass fake player text. */
export async function buildPortableReplay(input: PortableReplayInput): Promise<Blob> {
  const b64 = toBase64(new Uint8Array(await input.gz.arrayBuffer()))
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(input.title)}</title>
<style>${inertStyle(input.assets.css)}</style>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f7;color:#1c1c1e}h1{font-size:16px;margin:0 0 4px}#meta{color:#666;margin:0 0 12px}#replay-marks button{margin:2px 4px 2px 0;padding:3px 8px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer}#replay-box{max-width:940px}</style>
</head><body>
<h1>${escHtml(input.title)}</h1>
<p id="meta">Replay, ${formatDuration(input.durationMs)}. Plays offline; opens at the error.</p>
<div id="replay-marks"></div>
<div id="replay-box" data-evidence="${escHtml(input.evidenceId ?? '')}">Loading the recording…</div>
<script id="rec" type="text/plain">${b64}</script>
<script>${inertScript(input.assets.js)}</script>
<script>var FAILURE_LEAD_MS=${FAILURE_LEAD_MS};${inertScript(PAGE_JS)}</script>
</body></html>`
  return new Blob([html], { type: 'text/html' })
}
