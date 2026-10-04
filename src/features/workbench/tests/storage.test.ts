import { describe, expect, it } from 'vitest'
import { LocalWorkspaceRepository } from '../workspaceRepository'
import type { StorageService } from '../storageService'
import { createInitialDocument } from '../../../shared/models'

function memoryStorage(initial: string | null = null): StorageService {
  let value = initial
  return { read: async () => value, write: async (next) => { value = next } }
}

describe('local workspace repository', () => {
  it('round trips a document', async () => {
    const repository = new LocalWorkspaceRepository(memoryStorage())
    const document = createInitialDocument()
    await repository.save(document)
    await expect(repository.load()).resolves.toEqual(document)
  })

  it('falls back when stored JSON is damaged', async () => {
    const repository = new LocalWorkspaceRepository(memoryStorage('{broken'))
    await expect(repository.load()).resolves.toBeNull()
  })

  it('passes synchronous saves through to storage when supported', async () => {
    let synced: string | null = null
    const storage: StorageService = {
      read: async () => null,
      write: async () => {},
      writeSync: (next) => { synced = next },
    }
    const repository = new LocalWorkspaceRepository(storage)
    const document = createInitialDocument()
    repository.saveSync(document)
    expect(synced).toBe(JSON.stringify(document))
  })
})
