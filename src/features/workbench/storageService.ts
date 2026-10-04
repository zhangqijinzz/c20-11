import type { WorkspaceDocument } from '../../shared/models'

export const STORAGE_KEY = 'focusdesk.document.v1'
const DATABASE_NAME = 'focusdesk-db'
const STORE_NAME = 'workspace'

export interface StorageService {
  read(): Promise<string | null>
  write(value: string): Promise<void>
  writeSync(value: string): void
}

export class BrowserStorageService implements StorageService {
  async read(): Promise<string | null> {
    const [indexedValue, localValue] = await Promise.all([
      this.readIndexedDb().catch(() => null),
      Promise.resolve(window.localStorage.getItem(STORAGE_KEY)),
    ])

    const latest = selectLatestValue(indexedValue, localValue)
    return latest ?? localValue ?? indexedValue
  }

  async write(value: string): Promise<void> {
    let localError: unknown
    let indexedDbError: unknown

    try {
      this.writeSync(value)
    } catch (error) {
      localError = error
    }

    try {
      const database = await openDatabase()
      try {
        await writeToDatabase(database, value)
      } finally {
        database.close()
      }
    } catch (error) {
      indexedDbError = error
    }

    if (localError && indexedDbError) throw indexedDbError ?? localError
  }

  writeSync(value: string): void {
    window.localStorage.setItem(STORAGE_KEY, value)
  }

  private async readIndexedDb(): Promise<string | null> {
    const database = await openDatabase()
    try {
      const value = await readFromDatabase(database)
      return typeof value === 'string' ? value : null
    } finally {
      database.close()
    }
  }
}

export function selectLatestValue(first: string | null, second: string | null): string | null {
  if (!first) return second
  if (!second) return first

  const firstDocument = parseDocument(first)
  const secondDocument = parseDocument(second)
  if (!firstDocument) return second
  if (!secondDocument) return first

  return documentTimestamp(secondDocument) > documentTimestamp(firstDocument) ? second : first
}

function parseDocument(value: string): WorkspaceDocument | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isWorkspaceDocument(parsed) ? parsed : null
  } catch {
    return null
  }
}

function documentTimestamp(document: WorkspaceDocument): number {
  if (typeof document.revision === 'number') return document.revision
  return Date.parse(document.updatedAt ?? '') || 0
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
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
    transaction.objectStore(STORE_NAME).put(value, STORAGE_KEY)
  })
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceDocument>
  return candidate.version === 1 && Array.isArray(candidate.plans) && typeof candidate.activePlanId === 'string'
}
