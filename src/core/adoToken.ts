// Per-tester Azure DevOps token, stored only in this browser. Its own IndexedDB database
// ('dalil-ado'), never the pending-report one. The token is never logged or put in any payload.
import { AdoError, basicAuth, listWorkItemTypes } from '../../shared/adoClient'
import { adoFetch } from './adoFetch'

const DB = 'dalil-ado'
const STORE = 'tokens'

interface TokenRecord {
  pat: string
  savedAt: number
}

/** Used when IndexedDB is unavailable: lives for this page session only. */
const memory = new Map<string, TokenRecord>()

const keyOf = (org: string) => `ado:${org}`

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
    req.onblocked = () => reject(new Error('blocked'))
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

/** The saved token for an org, or null. */
export async function getToken(org: string): Promise<string | null> {
  const mem = memory.get(keyOf(org))
  if (mem) return mem.pat
  try {
    const rec = await tx<TokenRecord | undefined>('readonly', (s) => s.get(keyOf(org)) as IDBRequest<TokenRecord | undefined>)
    return typeof rec?.pat === 'string' && rec.pat ? rec.pat : null
  } catch {
    return null
  }
}

export interface SaveResult {
  /** false when IndexedDB is unavailable: the token is kept for this page session only */
  persisted: boolean
}

/**
 * Checks the token against the project (a work-item-types read needs only the Work Items scope),
 * then stores it. Throws AdoError: auth/forbidden = token rejected, notfound = project not found,
 * unavailable/timeout = could not reach Azure DevOps. Nothing is stored on failure.
 */
export async function saveToken(org: string, project: string, pat: string): Promise<SaveResult> {
  const token = pat.trim()
  if (!token) throw new AdoError('auth')
  await listWorkItemTypes({ fetch: adoFetch(), org, project, authHeader: basicAuth(token) })
  const rec: TokenRecord = { pat: token, savedAt: Date.now() }
  try {
    await tx('readwrite', (s) => s.put(rec, keyOf(org)))
    memory.delete(keyOf(org))
    return { persisted: true }
  } catch {
    memory.set(keyOf(org), rec)
    return { persisted: false }
  }
}

/** Removes the token everywhere it could be held. */
export async function forgetToken(org: string): Promise<void> {
  memory.delete(keyOf(org))
  try {
    await tx('readwrite', (s) => s.delete(keyOf(org)))
  } catch {
    /* nothing stored, or storage unavailable */
  }
}

/** Test hook. */
export function __resetTokensForTests(): void {
  memory.clear()
}
