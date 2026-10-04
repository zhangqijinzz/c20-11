import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocument } from '../../../shared/models'
import type { WorkspaceRepository } from '../workspaceRepository'
import { DebouncedSaveQueue, type SaveQueueStatus } from '../saveQueue'

function documentWithRevision(revision: number): WorkspaceDocument {
  return {
    version: 1,
    plans: [],
    activePlanId: 'plan-1',
    revision,
    updatedAt: new Date(revision).toISOString(),
  }
}

function controlledRepository() {
  const writes: number[] = []
  const controllers: Array<{ document: WorkspaceDocument; resolve: () => void; reject: (error: Error) => void }> = []

  const repository: WorkspaceRepository = {
    load: vi.fn(),
    save: vi.fn((document: WorkspaceDocument) => new Promise<void>((resolve, reject) => {
      writes.push(document.revision ?? 0)
      controllers.push({ document, resolve, reject })
    })),
    saveSync: vi.fn(),
  }

  return { repository, writes, controllers }
}

describe('debounced save queue', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces rapid changes and reports saving until the merged write finishes', async () => {
    vi.useFakeTimers()
    const statuses: SaveQueueStatus[] = []
    const { repository, writes, controllers } = controlledRepository()
    const queue = new DebouncedSaveQueue(repository, {
      delay: 400,
      onStatusChange: (status) => statuses.push(status),
    })

    queue.enqueue(documentWithRevision(1))
    queue.enqueue(documentWithRevision(2))
    queue.enqueue(documentWithRevision(3))
    await vi.advanceTimersByTimeAsync(399)
    expect(writes).toEqual([])
    expect(statuses[statuses.length - 1]).toBe('saving')

    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toEqual([3])
    expect(statuses[statuses.length - 1]).toBe('saving')

    controllers[0].resolve()
    await vi.runAllTimersAsync()
    expect(writes).toEqual([3])
    expect(statuses[statuses.length - 1]).toBe('ready')
  })

  it('runs queued writes in revision order', async () => {
    vi.useFakeTimers()
    const { repository, writes, controllers } = controlledRepository()
    const queue = new DebouncedSaveQueue(repository, { delay: 100 })

    queue.enqueue(documentWithRevision(1))
    await vi.advanceTimersByTimeAsync(100)
    queue.enqueue(documentWithRevision(2))
    expect(writes).toEqual([1])

    controllers[0].resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual([1, 2])

    controllers[1].resolve()
    await Promise.resolve()
    expect(writes).toEqual([1, 2])
  })

  it('keeps showing an error until a later write actually succeeds', async () => {
    vi.useFakeTimers()
    const statuses: SaveQueueStatus[] = []
    const { repository, writes, controllers } = controlledRepository()
    const queue = new DebouncedSaveQueue(repository, {
      delay: 50,
      onStatusChange: (status) => statuses.push(status),
    })

    queue.enqueue(documentWithRevision(1))
    await vi.advanceTimersByTimeAsync(50)
    controllers[0].reject(new Error('write failed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses[statuses.length - 1]).toBe('error')

    queue.enqueue(documentWithRevision(2))
    expect(statuses[statuses.length - 1]).toBe('saving')
    await vi.advanceTimersByTimeAsync(50)
    expect(writes).toEqual([1, 2])

    controllers[1].resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses[statuses.length - 1]).toBe('ready')
  })

  it('synchronously flushes the latest pending document before hiding the page', () => {
    vi.useFakeTimers()
    const saveSync = vi.fn()
    const repository: WorkspaceRepository = {
      load: vi.fn(),
      save: vi.fn(),
      saveSync,
    }
    const queue = new DebouncedSaveQueue(repository, { delay: 400 })
    const first = documentWithRevision(1)
    const latest = documentWithRevision(2)

    queue.enqueue(first)
    queue.enqueue(latest)
    queue.flushSync(saveSync)

    expect(saveSync).toHaveBeenCalledTimes(1)
    expect(saveSync).toHaveBeenCalledWith(latest)
    expect(queue.hasPendingChanges()).toBe(false)
  })
})
