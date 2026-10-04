import type { WorkspaceDocument } from '../../shared/models'

export const STORAGE_KEY = 'focusdesk.document.v1'
const DATABASE_NAME = 'focusdesk-db'
const STORE_NAME = 'workspace'

export interface StorageService {
  read(): Promise<string | null>
  write(value: string): Promise<void>
  writeSync?(value: string): void
}

interface StorageEnvelope {
  savedAt: string
  payload: string
}

export class BrowserStorageService implements StorageService {
  async read(): Promise<string | null> {
    const candidates: Array<string | null> = [readLocal()]
    try {
      const database = await openDatabase()
      try {
        const value = await readFromDatabase(database)
        candidates.push(typeof value === 'string' ? value : null)
      } finally {
        database.close()
      }
    } catch {
      // IndexedDB unavailable; whatever localStorage holds is all we have
    }
    let freshest: StorageEnvelope | null = null
    for (const raw of candidates) {
      const envelope = parseEnvelope(raw)
      if (envelope && (!freshest || envelope.savedAt > freshest.savedAt)) freshest = envelope
    }
    return freshest ? freshest.payload : null
  }

  async write(value: string): Promise<void> {
    const envelope = toEnvelope(value)
    // The synchronous localStorage copy is the safety net for page unload;
    // it also covers browsers where IndexedDB is unavailable.
    const localError = writeLocal(envelope)
    try {
      const database = await openDatabase()
      try {
        await writeToDatabase(database, envelope)
      } finally {
        database.close()
      }
    } catch (databaseError) {
      if (localError) throw databaseError
      // localStorage copy already landed, so the data is durable
    }
  }

  writeSync(value: string): void {
    const error = writeLocal(toEnvelope(value))
    if (error) throw error
  }
}

function toEnvelope(payload: string): string {
  const envelope: StorageEnvelope = { savedAt: new Date().toISOString(), payload }
  return JSON.stringify(envelope)
}

function parseEnvelope(raw: string | null): StorageEnvelope | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed as Partial<StorageEnvelope>
      if (typeof candidate.payload === 'string' && typeof candidate.savedAt === 'string') {
        return { savedAt: candidate.savedAt, payload: candidate.payload }
      }
    }
    // Legacy value: the raw document JSON stored before envelopes existed
    return { savedAt: '', payload: raw }
  } catch {
    return null
  }
}

function readLocal(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeLocal(value: string): unknown {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
    return null
  } catch (error) {
    return error ?? new Error('localStorage write failed')
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function readFromDatabase(database: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(STORAGE_KEY)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
  })
}

function writeToDatabase(database: IDBDatabase, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(value, STORAGE_KEY)
    // Resolve on transaction completion so callers know the write truly landed
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
  })
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceDocument>
  return candidate.version === 1 && Array.isArray(candidate.plans) && typeof candidate.activePlanId === 'string'
}
