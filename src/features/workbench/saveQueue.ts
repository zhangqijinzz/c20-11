import type { WorkspaceDocument } from '../../shared/models'
import type { WorkspaceRepository } from './workspaceRepository'

export type SaveQueueStatus = 'ready' | 'saving' | 'error'

interface PendingSave {
  document: WorkspaceDocument
  timer: ReturnType<typeof setTimeout>
}

export interface SaveQueueOptions {
  delay?: number
  onStatusChange?: (status: SaveQueueStatus) => void
}

export class DebouncedSaveQueue {
  private readonly delay: number
  private readonly onStatusChange?: (status: SaveQueueStatus) => void
  private pending: PendingSave | null = null
  private inFlight: WorkspaceDocument | null = null
  private syncedRevision = 0
  private chain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly repository: WorkspaceRepository, options: SaveQueueOptions = {}) {
    this.delay = options.delay ?? 400
    this.onStatusChange = options.onStatusChange
  }

  enqueue(document: WorkspaceDocument): void {
    if (this.disposed) return
    if (this.pending) clearTimeout(this.pending.timer)

    this.setStatus('saving')
    const timer = setTimeout(() => {
      const queued = this.pending
      this.pending = null
      if (queued) void this.write(queued.document).catch(() => {})
    }, this.delay)

    this.pending = { document, timer }
  }

  async flush(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending.timer)
      const { document } = this.pending
      this.pending = null
      await this.write(document)
    }
    await this.chain
  }

  flushSync(saveSync: (document: WorkspaceDocument) => void): void {
    if (!this.pending && !this.inFlight) return

    try {
      if (this.pending) clearTimeout(this.pending.timer)
      const documentToSync = this.pending?.document ?? this.inFlight
      if (!documentToSync) return
      saveSync(documentToSync)
      const revision = documentToSync.revision ?? 0
      if (revision > this.syncedRevision) this.syncedRevision = revision
      if (this.pending) this.pending = null
      this.inFlight = null
      this.setStatus('ready')
    } catch {
      this.setStatus('error')
    }
  }

  hasPendingChanges(): boolean {
    return this.pending !== null || this.inFlight !== null
  }

  dispose(): void {
    this.disposed = true
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }

  private write(document: WorkspaceDocument): Promise<void> {
    this.inFlight = document
    this.setStatus('saving')

    const writeOperation = this.chain.then(async () => {
      await this.repository.save(document)
    }).then(() => {
      if (this.inFlight === document && (document.revision ?? 0) <= this.syncedRevision) {
        this.inFlight = null
        return
      }
      if (this.inFlight === document) {
        this.inFlight = null
        if (!this.pending) this.setStatus('ready')
      }
    }, (error: unknown) => {
      if (this.inFlight === document && (document.revision ?? 0) > this.syncedRevision) {
        this.inFlight = null
        if (!this.pending) this.setStatus('error')
      }
      throw error
    })

    // Keep write failures in order without creating an unhandled rejection.
    this.chain = writeOperation.catch(() => undefined)
    return writeOperation
  }

  private setStatus(status: SaveQueueStatus): void {
    this.onStatusChange?.(status)
  }
}
