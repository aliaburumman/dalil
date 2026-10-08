// POST /v1/reports and its CORS preflight (design §3 "Collector").
import { deliverEmail, refOf, type StoredImage } from './email'
import type { Env, ProjectRow, ReportRow } from './env'
import { AUTO_PART, IMAGE_PART, LIMITS } from './limits'
import { type ReportPayload, SUPPORTED_VERSIONS, type SubmitResult } from './payload'
import { checkRateLimits, takeReplaySlot } from './ratelimit'
import { scrubSecrets } from './scrub'
import { failedRequests } from './steps'
import { json, parseJsonArray, partKey, timingSafeEqual } from './util'

const REPLAY_PART = 'replay'

export const MAX_BODY = LIMITS.bodyBytes
export const MAX_REPORT = LIMITS.reportBytes
export const MAX_IMAGES = LIMITS.images
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const SEVERITIES = new Set(['blocker', 'annoying', 'minor'])

export async function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  return env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>()
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-dalil-key, x-dalil-project',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

/**
 * Preflight. Browsers never send custom header VALUES in a preflight (only their names in
 * Access-Control-Request-Headers), so X-Dalil-Project cannot scope it. If the endpoint
 * carries ?project=<id> the origin is checked against that project; otherwise against the
 * union of all projects' allowed_origins. The real POST is then checked per project.
 */
export async function handlePreflight(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('origin')
  if (!origin) return new Response(null, { status: 403 })
  const projectId = new URL(req.url).searchParams.get('project')
  let allowed = false
  if (projectId) {
    const p = await getProject(env, projectId)
    allowed = !!p && parseJsonArray(p.allowed_origins).includes(origin)
  } else {
    const hit = await env.DB.prepare('SELECT 1 FROM projects, json_each(projects.allowed_origins) WHERE json_each.value = ? LIMIT 1')
      .bind(origin)
      .first()
    allowed = !!hit
  }
  if (!allowed) return new Response(null, { status: 403, headers: { vary: 'Origin' } })
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp'
  return null
}

/**
 * Streams the gzip through DecompressionStream, counting bytes without keeping them.
 * 'bomb' = decompressed size over the cap; 'corrupt' = not valid gzip.
 */
async function checkGzip(bytes: Uint8Array, cap: number): Promise<'ok' | 'bomb' | 'corrupt'> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return 'ok'
      total += value.byteLength
      if (total > cap) {
        await reader.cancel().catch(() => undefined)
        return 'bomb'
      }
    }
  } catch {
    return 'corrupt'
  }
}

function validatePayload(p: unknown, projectId: string): string | null {
  if (!p || typeof p !== 'object') return 'report must be a JSON object'
  const r = p as Partial<ReportPayload>
  if (typeof r.v !== 'number' || !SUPPORTED_VERSIONS.includes(r.v)) return `unsupported payload version (expected ${SUPPORTED_VERSIONS.join(' or ')})`
  if (r.project !== projectId) return 'report.project does not match X-Dalil-Project'
  if (typeof r.title !== 'string' || !r.title.trim()) return 'title is required'
  if (!r.severity || !SEVERITIES.has(r.severity)) return 'invalid severity'
  if (!r.verdict || typeof r.verdict !== 'object' || typeof r.verdict.kind !== 'string') return 'invalid verdict'
  if (!Array.isArray(r.events)) return 'events must be an array'
  if (!r.env || typeof r.env !== 'object') return 'env is required'
  if (r.curls !== undefined && (typeof r.curls !== 'object' || r.curls === null)) return 'curls must be an object'
  if (r.images !== undefined && !Array.isArray(r.images)) return 'images must be an array'
  return null
}

type Allocate = (attempt: number) => Promise<number>

async function insertWithSeq(allocate: Allocate): Promise<number> {
  try {
    return await allocate(0)
  } catch (err) {
    if (!/UNIQUE/i.test(String(err))) throw err
    return allocate(1) // one retry on a seq collision
  }
}

export async function handleIngest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = req.headers.get('origin')
  const projectId = req.headers.get('x-dalil-project')
  const key = req.headers.get('x-dalil-key')
  if (!projectId || !key) return json({ error: 'missing X-Dalil-Project or X-Dalil-Key' }, 401)

  const project = await getProject(env, projectId)
  if (!project || !timingSafeEqual(key, project.public_key)) return json({ error: 'invalid project or key' }, 401)
  if (!origin || !parseJsonArray(project.allowed_origins).includes(origin)) return json({ error: 'origin not allowed' }, 403)

  const cors = corsHeaders(origin)
  const fail = (error: string, status: number) => json({ error }, status, cors)

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY) return fail('request too large (max 8 MB)', 413)

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  const limited = await checkRateLimits(env, project.id, ip)
  if (limited) return fail(limited, 429)

  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return fail('expected multipart/form-data', 415)
  const raw = await readCapped(req.body, MAX_BODY)
  if (!raw) return fail('request too large (max 8 MB)', 413)

  let form: FormData
  try {
    form = await new Response(raw, { headers: { 'content-type': contentType } }).formData()
  } catch {
    return fail('malformed multipart body', 400)
  }

  // Parts: exactly one "report", image_0..image_5, auto_0..auto_2, and an optional "replay".
  let reportText: string | null = null
  const images: StoredImage[] = []
  const autos: StoredImage[] = []
  let replayBytes: Uint8Array | null = null
  let imageCount = 0
  let autoCount = 0
  for (const [name, value] of form.entries()) {
    if (name === 'report') {
      const text = typeof value === 'string' ? value : await (value as unknown as Blob).text()
      if (new TextEncoder().encode(text).byteLength > MAX_REPORT) return fail('report part too large (max 1 MB)', 413)
      reportText = text
      continue
    }
    const isImage = IMAGE_PART.test(name)
    const isAuto = AUTO_PART.test(name)
    if (!isImage && !isAuto && name !== REPLAY_PART) return fail(`unexpected part "${name}"`, 400)
    if (isImage && ++imageCount > MAX_IMAGES) return fail(`too many images (max ${MAX_IMAGES})`, 400)
    if (isAuto && ++autoCount > LIMITS.autoSnaps) return fail(`too many auto snapshots (max ${LIMITS.autoSnaps})`, 400)
    if (typeof value === 'string') return fail(`${name} must be a file`, 400)
    const file = value as unknown as File
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (name === REPLAY_PART) {
      if (replayBytes) return fail('duplicate replay part', 400)
      if (bytes.byteLength > LIMITS.replayBytes) return fail(`replay too large (max ${LIMITS.replayBytes / 1_000_000} MB compressed)`, 413)
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return fail('replay must be gzip', 400)
      const verdict = await checkGzip(bytes, LIMITS.replayDecompressedBytes)
      if (verdict === 'bomb') return fail(`replay too large when decompressed (max ${LIMITS.replayDecompressedBytes / 1_000_000} MB)`, 413)
      if (verdict === 'corrupt') return fail('replay is not valid gzip', 400)
      replayBytes = bytes
      continue
    }
    const cap = isAuto ? LIMITS.autoSnapBytes : LIMITS.imageBytes
    if (bytes.byteLength > cap) return fail(`${name} too large (max ${cap / 1000} KB)`, 413)
    const sniffed = sniffImage(bytes)
    if (!IMAGE_TYPES.has(file.type) || !sniffed) return fail(`${name}: only jpeg, png or webp`, 400)
    ;(isAuto ? autos : images).push({ part: name, name: file.name || name, kind: isAuto ? 'auto' : 'attachment', type: sniffed, bytes })
  }
  if (reportText === null) return fail('missing "report" part', 400)

  const { text: cleanText, scrubbed } = scrubSecrets(reportText)
  let payload: ReportPayload
  try {
    payload = JSON.parse(cleanText) as ReportPayload
  } catch {
    return fail('report is not valid JSON', 400)
  }
  const invalid = validatePayload(payload, project.id)
  if (invalid) return fail(invalid, 400)

  // Image kinds come from payload.images; a part not listed there stays an attachment.
  for (const img of images) {
    const meta = payload.images?.find((m) => m.part === img.part)
    if (meta) {
      img.kind = meta.kind === 'screenshot' ? 'screenshot' : 'attachment'
      if (meta.name) img.name = meta.name
    }
  }
  // Keep payload.images consistent with what was actually stored (auto snaps included).
  payload.images = [...images, ...autos].map((i) => ({ part: i.part, kind: i.kind, name: i.name }))
  const autoParts = new Set(autos.map((a) => a.part))
  if (payload.autoSnaps !== undefined) {
    payload.autoSnaps = Array.isArray(payload.autoSnaps) ? payload.autoSnaps.filter((a) => a && autoParts.has(a.part)) : []
  }

  // Replay: hourly cap per ip+project; over it the report is kept and the replay dropped.
  let replayDropped = false
  if (replayBytes && !(await takeReplaySlot(env, project.id, ip))) {
    replayBytes = null
    replayDropped = true
    delete payload.replay
    payload.replayError = 'replay dropped: hourly replay limit reached for this client'
  } else if (!replayBytes) {
    delete payload.replay
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  const r2Prefix = `reports/${project.id}/${id}/`
  const requestIds = failedRequests(payload)
    .map((e) => e.requestId)
    .filter((x): x is string => !!x)

  const seq = await insertWithSeq(async () => {
    const row = await env.DB.prepare(
      `INSERT INTO reports (id, project_id, seq, title, verdict_kind, verdict_headline, severity,
                            page_url, reporter, request_ids, created_at, r2_prefix, scrubbed,
                            has_replay, auto_snaps, replay_dropped)
       SELECT ?1, ?2, COALESCE(MAX(seq), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
       FROM reports WHERE project_id = ?2
       RETURNING seq`,
    )
      .bind(
        id,
        project.id,
        payload.title,
        payload.verdict.kind,
        payload.verdict.headline ?? null,
        payload.severity,
        payload.env?.url ?? null,
        JSON.stringify(payload.context ?? {}),
        JSON.stringify(requestIds),
        now,
        r2Prefix,
        scrubbed ? 1 : 0,
        replayBytes ? 1 : 0,
        autos.length,
        replayDropped ? 1 : 0,
      )
      .first<{ seq: number }>()
    if (!row) throw new Error('insert returned no seq')
    return row.seq
  })

  const stored = JSON.stringify(payload)
  const allImages = [...images, ...autos]
  const keys = [`${r2Prefix}report.json`, ...allImages.map((i) => `${r2Prefix}${partKey(i.part)}`), ...(replayBytes ? [`${r2Prefix}replay.json.gz`] : [])]
  try {
    await Promise.all([
      env.BUCKET.put(`${r2Prefix}report.json`, stored, { httpMetadata: { contentType: 'application/json' } }),
      ...allImages.map((img) => env.BUCKET.put(`${r2Prefix}${partKey(img.part)}`, img.bytes, { httpMetadata: { contentType: img.type } })),
      ...(replayBytes ? [env.BUCKET.put(`${r2Prefix}replay.json.gz`, replayBytes, { httpMetadata: { contentType: 'application/gzip' } })] : []),
    ])
  } catch (err) {
    console.error(`dalil: R2 write failed for ${id}: ${String(err)}`)
    await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(id).run()
    ctx.waitUntil(env.BUCKET.delete(keys).catch(() => undefined))
    return fail('storage failed, please retry', 500)
  }

  const ref = refOf(project, seq)
  const result: SubmitResult = { id, ref, url: `${env.PUBLIC_BASE}/r/${id}` }

  const row: ReportRow = {
    id,
    project_id: project.id,
    seq,
    title: payload.title,
    verdict_kind: payload.verdict.kind,
    verdict_headline: payload.verdict.headline ?? null,
    severity: payload.severity,
    status: 'new',
    page_url: payload.env?.url ?? null,
    reporter: null,
    request_ids: null,
    created_at: now,
    r2_prefix: r2Prefix,
    email_status: 'pending',
    scrubbed: scrubbed ? 1 : 0,
    has_replay: replayBytes ? 1 : 0,
    auto_snaps: autos.length,
    replay_dropped: replayDropped ? 1 : 0,
  }
  ctx.waitUntil(deliverEmail(env, row, project, { payload, images: allImages }))

  return json(result, 201, cors)
}
