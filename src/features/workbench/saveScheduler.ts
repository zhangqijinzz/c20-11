import type { WorkspaceDocument } from '../../shared/models'

export type SaveState = 'saving' | 'saved' | 'error'

export interface SaveSchedulerOptions {
  save: (document: WorkspaceDocument) => Promise<void>
  saveSync?: (document: WorkspaceDocument) => void
  debounceMs?: number
  onStateChange?: (state: SaveState) => void
}

const DEFAULT_DEBOUNCE_MS = 400

/**
 * Coalesces rapid edits into a single write and serializes writes through a
 * promise chain so they complete in order. State only reports `saved` when
 * the newest document has actually been persisted, and only reports `error`
 * when the newest write has actually failed.
 */
export class SaveScheduler {
  private readonly save: (document: WorkspaceDocument) => Promise<void>
  private readonly saveSync?: (document: WorkspaceDocument) => void
  private readonly debounceMs: number
  private readonly onStateChange?: (state: SaveState) => void

  private latest: WorkspaceDocument | null = null
  private dirty = false
  private writing = false
  private failed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(options: SaveSchedulerOptions) {
    this.save = options.save
    this.saveSync = options.saveSync
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.onStateChange = options.onStateChange
  }

  schedule(document: WorkspaceDocument): void {
    this.latest = document
    this.dirty = true
    this.failed = false
    this.emit()
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.kick()
    }, this.debounceMs)
  }

  /**
   * Persist pending changes immediately. Used before the page hides or
   * unloads: lands a synchronous best-effort copy first, then runs the
   * ordered async write.
   */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.latest) return
    if (this.saveSync) {
      try {
        this.saveSync(this.latest)
      } catch {
        // best effort only; the async write below is the source of truth
      }
    }
    void this.kick()
  }

  dispose(): void {
    this.flushNow()
  }

  private kick(): Promise<void> {
    this.chain = this.chain.then(() => this.drain())
    return this.chain
  }

  private async drain(): Promise<void> {
    while (this.dirty && this.latest) {
      const snapshot = this.latest
      this.dirty = false
      this.writing = true
      this.emit()
      try {
        await this.save(snapshot)
        this.failed = false
      } catch {
        // The snapshot did not land: stay dirty so the state honestly
        // reports the error and the next edit or flush retries.
        this.dirty = true
        this.failed = true
      } finally {
        this.writing = false
        this.emit()
      }
      if (this.failed) return
    }
  }

  private emit(): void {
    if (!this.onStateChange) return
    if (this.writing || (this.dirty && !this.failed)) this.onStateChange('saving')
    else if (this.failed) this.onStateChange('error')
    else this.onStateChange('saved')
  }
}
