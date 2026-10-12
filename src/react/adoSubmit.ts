// Lazy chunk: files a Bug straight into Azure DevOps from the browser (no collector).
// All requests go through adoFetch() (the recorder's original fetch, marked internal), so Dalil's own
// calls never appear as request events. The PAT is only ever put in the Authorization header.
import {
  AdoError,
  basicAuth,
  createWorkItem,
  formatDuration,
  uploadAttachment,
  type AdoContext,
  type AdoMedia,
} from '../../shared/adoClient'
import { buildShare } from '../../shared/share'
import { scrubSecrets } from '../../shared/scrub'
import { esc } from '../../shared/text'
import type { ReportPayload, Share } from '../../shared/payload'
import { adoFetch } from '../core/adoFetch'
import { zipStore, type ZipFile } from '../core/zip'
import type { AdoDestination } from '../core/types'
import type { SubmitImage } from '../core/submit'

export { AdoError }

const CONCURRENCY = 3

interface PreparedUpload {
  name: string
  blob: Blob
  kind: 'screenshot' | 'auto' | 'replay'
  label: string
}

/** Everything a retry or a zip needs; held in memory until the tester is done. */
export interface PreparedAdo {
  payload: ReportPayload
  share: Share
  uploads: PreparedUpload[]
  /** portable replay file, or the raw gz when the player could not be loaded */
  replay: { blob: Blob; name: string; portable: boolean; durationMs: number } | null
  scrubbed: boolean
}

export interface AdoSubmitResult {
  id: number
  url: string
  /** the Copy-report share, ending with the Bug link */
  share: Share
  /** images that could not be attached */
  failedMedia: number
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'capture'

function stamp(t: number): string {
  const d = new Date(Number.isFinite(t) ? t : Date.now())
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

function ext(blob: Blob, fallback: string): string {
  if (blob.type === 'image/png') return 'png'
  if (blob.type === 'image/webp') return 'webp'
  if (blob.type === 'image/gif') return 'gif'
  if (blob.type === 'image/jpeg') return 'jpg'
  return fallback
}

/** Scrub, build the share and the portable replay. Slow parts happen once; retries reuse the result. */
export async function prepareAdoReport(args: { payload: ReportPayload; uploads: SubmitImage[]; playerUrl?: string }): Promise<PreparedAdo> {
  const { text, scrubbed } = scrubSecrets(JSON.stringify(args.payload))
  const payload = JSON.parse(text) as ReportPayload
  const share = buildShare({
    ref: payload.project,
    title: payload.title,
    verdict: payload.verdict,
    events: payload.events,
    pageUrl: payload.env?.url,
    createdAt: payload.createdAt,
  })
  const byPart = new Map(args.uploads.map((u) => [u.part, u]))
  const uploads: PreparedUpload[] = []
  let n = 0
  for (const meta of payload.images) {
    const u = byPart.get(meta.part)
    if (!u) continue
    n++
    uploads.push({ name: `screenshot-${n}.${ext(u.blob, 'jpg')}`, blob: u.blob, kind: 'screenshot', label: '' })
  }
  let a = 0
  for (const meta of payload.autoSnaps ?? []) {
    const u = byPart.get(meta.part)
    if (!u) continue
    a++
    uploads.push({ name: `auto-${a}-${slug(meta.label)}.${ext(u.blob, 'jpg')}`, blob: u.blob, kind: 'auto', label: meta.label })
  }
  let replay: PreparedAdo['replay'] = null
  const gz = byPart.get('replay')
  if (gz && payload.replay) {
    const durationMs = payload.replay.durationMs
    const base = `replay-${stamp(payload.createdAt)}`
    let html: Blob | null = null
    try {
      const mod = await import('./portableReplay')
      const assets = await mod.loadPlayerAssets(args.playerUrl)
      if (assets) {
        html = await mod.buildPortableReplay({ gz: gz.blob, title: share.title, durationMs, evidenceId: payload.verdict?.evidenceEventId, assets })
      }
    } catch {
      html = null
    }
    replay = html
      ? { blob: html, name: `${base}.html`, portable: true, durationMs }
      : { blob: gz.blob, name: `${base}.json.gz`, portable: false, durationMs }
  }
  return { payload, share, uploads, replay, scrubbed }
}

async function pool<T>(items: Array<() => Promise<T>>, size: number): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const out: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = new Array(items.length)
  let next = 0
  let fatal: unknown = null
  const worker = async () => {
    while (fatal === null) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { ok: true, value: await items[i]!() }
      } catch (error) {
        out[i] = { ok: false, error }
        // Only a rejected single file is skippable; auth, access and connectivity problems stop everything.
        if (!(error instanceof AdoError) || error.code !== 'rejected') fatal = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  if (fatal !== null) throw fatal
  return out
}

function workItemId(url: string): number | null {
  const m = /\/_workitems\/edit\/(\d+)/.exec(url)
  return m ? Number(m[1]) : null
}

function replayBlock(r: NonNullable<PreparedAdo['replay']>, attachmentUrl: string | null): string {
  if (!attachmentUrl) return `<p>Replay recording couldn't be attached.</p>`
  if (r.portable) return `<p><a href="${esc(attachmentUrl)}">▶ Open ${esc(r.name)} (${formatDuration(r.durationMs)})</a> (download, then open the file; it plays offline)</p>`
  return `<p><a href="${esc(attachmentUrl)}">Replay recording attached (open with the Dalil player)</a>: ${esc(r.name)} (${formatDuration(r.durationMs)})</p>`
}

/** Upload everything (3 at a time, order kept) and create the Bug. Throws AdoError. */
export async function sendAdoReport(args: { prepared: PreparedAdo; dest: AdoDestination; pat: string }): Promise<AdoSubmitResult> {
  const { prepared, dest } = args
  const ctx: AdoContext = {
    fetch: adoFetch(),
    org: dest.org,
    project: dest.project,
    authHeader: basicAuth(args.pat),
    workItemType: dest.workItemType,
    bodyField: dest.bodyField,
  }
  const jobs: Array<() => Promise<string>> = prepared.uploads.map((u) => async () => uploadAttachment(ctx, await u.blob.arrayBuffer(), u.name))
  if (prepared.replay) {
    const r = prepared.replay
    jobs.push(async () => uploadAttachment(ctx, await r.blob.arrayBuffer(), r.name))
  }
  const results = await pool(jobs, CONCURRENCY)

  const media: AdoMedia[] = []
  let failedMedia = 0
  prepared.uploads.forEach((u, i) => {
    const r = results[i]!
    if (r.ok) media.push({ url: r.value, kind: u.kind === 'auto' ? 'auto' : 'screenshot', label: u.label })
    else failedMedia++
  })
  let replayUrl: string | null = null
  if (prepared.replay) {
    const r = results[prepared.uploads.length]!
    if (r.ok) replayUrl = r.value
  }

  // The Bug title is the report title only; the heading prefix stays in the share text/html.
  const url = await createWorkItem(ctx, { ...prepared.share, title: prepared.payload.title.trim().slice(0, 255) }, {
    extras: { media, failedMedia, extraHtml: prepared.replay ? replayBlock(prepared.replay, replayUrl) : undefined },
    attachments: replayUrl ? [{ url: replayUrl, comment: 'Dalil replay' }] : undefined,
    tags: ['dalil', ...(dest.tags ?? [])],
    areaPath: dest.areaPath,
  })
  const id = workItemId(url)

  const label = id !== null ? `${dest.workItemType || 'Bug'} #${id}` : dest.workItemType || 'Bug'
  const rebuilt = buildShare({
    ref: prepared.payload.project,
    title: prepared.payload.title,
    verdict: prepared.payload.verdict,
    events: prepared.payload.events,
    pageUrl: prepared.payload.env?.url,
    createdAt: prepared.payload.createdAt,
    url,
  })
  return {
    id: id ?? 0,
    url,
    failedMedia,
    share: {
      title: rebuilt.title,
      html: rebuilt.html.replace('Full evidence (screenshot, replay)', esc(label)),
      text: rebuilt.text.replace('Full evidence: ', `${label}: `),
    },
  }
}

/** The "Download evidence" zip: report text/html, images, replay and the scrubbed report JSON. */
export async function buildEvidenceZip(prepared: PreparedAdo): Promise<Blob> {
  const enc = new TextEncoder()
  const files: ZipFile[] = [{ name: 'report.txt', data: enc.encode(prepared.share.text) }]
  let imgs = ''
  const images: ZipFile[] = []
  for (const u of prepared.uploads) {
    images.push({ name: u.name, data: new Uint8Array(await u.blob.arrayBuffer()) })
    const cap = u.kind === 'auto' ? `<br>${esc(`Auto: ${u.label}`)}` : ''
    imgs += `<p><img src="${esc(u.name)}" alt="${esc(u.label || u.name)}" style="max-width:100%">${cap}</p>`
  }
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(prepared.share.title)}</title>${prepared.share.html}${imgs}`
  files.push({ name: 'report.html', data: enc.encode(html) }, ...images)
  if (prepared.replay) {
    files.push({ name: prepared.replay.portable ? 'replay.html' : 'replay.json.gz', data: new Uint8Array(await prepared.replay.blob.arrayBuffer()) })
  }
  files.push({ name: 'report.json', data: enc.encode(JSON.stringify(prepared.payload, null, 2)) })
  return new Blob([zipStore(files) as BlobPart], { type: 'application/zip' })
}
