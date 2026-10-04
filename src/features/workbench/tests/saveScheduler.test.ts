import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveScheduler, type SaveState } from '../saveScheduler'
import { createInitialDocument, type WorkspaceDocument } from '../../../shared/models'

function documentNamed(name: string): WorkspaceDocument {
  const document = createInitialDocument()
  return { ...document, plans: document.plans.map((plan) => ({ ...plan, name })) }
}

describe('save scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid changes into a single write of the latest document', async () => {
    const save = vi.fn(async (_document: WorkspaceDocument) => {})
    const scheduler = new SaveScheduler({ save, debounceMs: 400 })
    scheduler.schedule(documentNamed('a'))
    scheduler.schedule(documentNamed('b'))
    scheduler.schedule(documentNamed('c'))
    await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].plans[0].name).toBe('c')
  })

  it('completes writes in order and only reports saved after the newest write lands', async () => {
    const written: string[] = []
    let releaseFirst: (() => void) | null = null
    const states: SaveState[] = []
    const save = vi.fn((document: WorkspaceDocument) => new Promise<void>((resolve) => {
      written.push(document.plans[0].name)
      if (written.length === 1) releaseFirst = () => resolve()
      else resolve()
    }))
    const scheduler = new SaveScheduler({ save, debounceMs: 400, onStateChange: (state) => states.push(state) })

    scheduler.schedule(documentNamed('first'))
    await vi.advanceTimersByTimeAsync(400)
    expect(written).toEqual(['first'])
    expect(states[states.length - 1]).toBe('saving')

    // A newer edit arrives while the first write is still in flight
    scheduler.schedule(documentNamed('second'))
    await vi.advanceTimersByTimeAsync(400)
    expect(written).toEqual(['first'])
    expect(states[states.length - 1]).toBe('saving')

    releaseFirst!()
    await vi.advanceTimersByTimeAsync(0)
    expect(written).toEqual(['first', 'second'])
    expect(states[states.length - 1]).toBe('saved')
  })

  it('reports error only when the newest write actually fails, and recovers on the next edit', async () => {
    const states: SaveState[] = []
    let shouldFail = true
    const save = vi.fn(async () => {
      if (shouldFail) throw new Error('storage full')
    })
    const scheduler = new SaveScheduler({ save, debounceMs: 400, onStateChange: (state) => states.push(state) })

    scheduler.schedule(documentNamed('a'))
    await vi.advanceTimersByTimeAsync(400)
    expect(states[states.length - 1]).toBe('error')

    shouldFail = false
    scheduler.schedule(documentNamed('b'))
    await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledTimes(2)
    expect(states[states.length - 1]).toBe('saved')
  })

  it('flushes pending changes immediately without waiting for the debounce window', async () => {
    const save = vi.fn(async (_document: WorkspaceDocument) => {})
    const saveSync = vi.fn()
    const scheduler = new SaveScheduler({ save, saveSync, debounceMs: 400 })

    const latest = documentNamed('pending')
    scheduler.schedule(latest)
    scheduler.flushNow()

    expect(saveSync).toHaveBeenCalledTimes(1)
    expect(saveSync.mock.calls[0][0].plans[0].name).toBe('pending')
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)

    // The cancelled debounce timer must not write again afterwards
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
