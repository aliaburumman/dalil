import { getConfig, getOriginalFetch } from './recorder'
import type { ReportPayload, SubmitResult } from './types'

export interface SubmitImage {
  part: string
  name: string
  blob: Blob
}

export type SubmitErrorCode = 'queued' | 'rejected' | 'not_initialized'

/** Thrown by submit(). `queued` = network failed, report kept in IndexedDB for flushPending(). */
export class DalilSubmitError extends Error {
  readonly code: SubmitErrorCode
  readonly status?: number
  constructor(code: SubmitErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'DalilSubmitError'
    this.code = code
    this.status = status
  }
}

const DB = 'dalil'
const STORE = 'pending'
const KEY = 'current'
const TTL_MS = 24 * 60 * 60 * 1000

interface PendingRecord {
  payload: ReportPayload
  images: SubmitImage[]
  endpoint: string
  project?: string
  publicKey: string
  createdAt: number
}

function buildForm(payload: ReportPayload, images: SubmitImage[]): FormData {
  const fd = new FormData()
  fd.append('report', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'report.json')
  for (const img of images) fd.append(img.part, img.blob, img.name)
  return fd
}

/** Adds ?project=<id> (the worker scopes CORS preflight by it) unless already present. */
function withProject(endpoint: string, project: string): string {
  try {
    const u = new URL(endpoint, typeof location !== 'undefined' ? location.href : undefined)
    if (!u.searchParams.has('project')) u.searchParams.set('project', project)
    return u.toString()
  } catch {
    return endpoint
  }
}

async function send(
  endpoint: string,
  project: string,
  key: string,
  payload: ReportPayload,
  images: SubmitImage[],
): Promise<Response> {
  return getOriginalFetch()(withProject(endpoint, project), {
    method: 'POST',
    headers: { 'X-Dalil-Project': project, 'X-Dalil-Key': key },
    body: buildForm(payload, images),
  })
}

async function readResult(res: Response): Promise<SubmitResult> {
  if (!res.ok) {
    let message = `Report rejected (${res.status})`
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text) as { error?: unknown; message?: unknown }
        const m = j.message ?? j.error
        if (typeof m === 'string' && m) message = m
      } catch {
        if (text) message = text.slice(0, 300)
      }
    } catch {
      /* keep default */
    }
    throw new DalilSubmitError('rejected', message, res.status)
  }
  return (await res.json()) as SubmitResult
}

// ---------------- IndexedDB (one pending report) ----------------

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : null
  } catch {
    return null
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const f = idb()
    if (!f) return reject(new Error('IndexedDB unavailable'))
    const req = f.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const r = fn(t.objectStore(STORE))
      t.oncomplete = () => resolve(r.result)
      t.onerror = () => reject(t.error ?? r.error)
      t.onabort = () => reject(t.error ?? new Error('aborted'))
    })
  } finally {
    db.close()
  }
}

const putPending = (rec: PendingRecord) => tx('readwrite', (s) => s.put(rec, KEY))
const getPending = () => tx<PendingRecord | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<PendingRecord | undefined>)
const deletePending = () => tx('readwrite', (s) => s.delete(KEY))

/**
 * POSTs the report as multipart ('report' JSON + image parts) with the
 * original, unpatched fetch. Network failure → the report is stored (one slot)
 * and a DalilSubmitError {code:'queued'} is thrown. Non-2xx → {code:'rejected'}.
 */
export async function submit(payload: ReportPayload, images: SubmitImage[] = []): Promise<SubmitResult> {
  const cfg = getConfig()
  if (!cfg) throw new DalilSubmitError('not_initialized', 'dalil.init() has not been called')
  let res: Response
  try {
    res = await send(cfg.endpoint, cfg.project, cfg.publicKey, payload, images)
  } catch (err) {
    try {
      await putPending({ payload, images, endpoint: cfg.endpoint, project: cfg.project, publicKey: cfg.publicKey, createdAt: Date.now() })
    } catch {
      throw new DalilSubmitError('queued', 'Network error; the report could not be saved for retry')
    }
    throw new DalilSubmitError('queued', `Network error; report saved and will be retried (${(err as Error)?.message ?? err})`)
  }
  return readResult(res)
}

let flushing: Promise<SubmitResult | null> | null = null

/**
 * Resends the pending report if it is under 24 h old, otherwise drops it.
 * Keeps it on another network failure; drops it when the collector rejects it.
 */
export function flushPending(): Promise<SubmitResult | null> {
  if (flushing) return flushing
  flushing = (async () => {
    if (!idb()) return null
    let rec: PendingRecord | undefined
    try {
      rec = await getPending()
    } catch {
      return null
    }
    if (!rec) return null
    if (!(Date.now() - rec.createdAt < TTL_MS)) {
      await deletePending().catch(() => {})
      return null
    }
    let res: Response
    try {
      res = await send(rec.endpoint, rec.project ?? rec.payload.project, rec.publicKey, rec.payload, rec.images ?? [])
    } catch {
      return null // still offline; keep it
    }
    if (res.status >= 500) return null // collector hiccup; keep it for the next init
    try {
      return await readResult(res)
    } catch {
      return null
    } finally {
      await deletePending().catch(() => {})
    }
  })().finally(() => {
    flushing = null
  })
  return flushing
}
