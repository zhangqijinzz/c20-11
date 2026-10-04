import { describe, expect, it } from 'vitest'
import { LocalWorkspaceRepository } from '../workspaceRepository'
import type { StorageService } from '../storageService'
import { selectLatestValue, STORAGE_KEY } from '../storageService'
import { createInitialDocument } from '../../../shared/models'

function memoryStorage(initial: string | null = null): StorageService {
  let value = initial
  return {
    read: async () => value,
    write: async (next) => { value = next },
    writeSync: (next) => { value = next },
  }
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
})

describe('selectLatestValue', () => {
  it('prefers the document with the newest revision', () => {
    const older = JSON.stringify({ version: 1, plans: [], activePlanId: 'plan', revision: 3 })
    const newer = JSON.stringify({ version: 1, plans: [], activePlanId: 'plan', revision: 4 })
    expect(selectLatestValue(older, newer)).toBe(newer)
    expect(selectLatestValue(newer, older)).toBe(newer)
  })

  it('falls back to readable JSON when one value is damaged', () => {
    const valid = JSON.stringify({ version: 1, plans: [], activePlanId: 'plan' })
    expect(selectLatestValue('{broken', valid)).toBe(valid)
    expect(selectLatestValue(valid, '{broken')).toBe(valid)
  })

  it('exposes the localStorage key used by synchronous unload saves', () => {
    expect(STORAGE_KEY).toBe('focusdesk.document.v1')
  })
})
