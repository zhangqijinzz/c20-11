// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { BrowserStorageService, STORAGE_KEY } from '../storageService'

describe('browser storage service', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round trips a payload through the synchronous fallback store', async () => {
    const service = new BrowserStorageService()
    await service.write('{"version":1}')
    await expect(service.read()).resolves.toBe('{"version":1}')
  })

  it('reads legacy raw documents stored before envelopes existed', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{"version":1,"plans":[],"activePlanId":"p1"}')
    const service = new BrowserStorageService()
    await expect(service.read()).resolves.toBe('{"version":1,"plans":[],"activePlanId":"p1"}')
  })

  it('writeSync lands a copy that read can recover', async () => {
    const service = new BrowserStorageService()
    service.writeSync('{"emergency":true}')
    await expect(service.read()).resolves.toBe('{"emergency":true}')
  })

  it('returns null when nothing is stored', async () => {
    const service = new BrowserStorageService()
    await expect(service.read()).resolves.toBeNull()
  })
})
