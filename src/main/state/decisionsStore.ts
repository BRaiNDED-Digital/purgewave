import { writeJsonAtomic } from './atomicWrite'
import { getDecisionsFilePath } from './paths'
import type { DecisionEntry, DecisionsFile } from '../../shared/types'

const DEBOUNCE_MS = 2000

/**
 * Debounced, serialized writer for decisions.json per §3.3/§3.7 rule 1: a swipe write must
 * never sit in the visual path, so `set()` only updates the in-memory copy and schedules a
 * flush — callers must never await it from the swipe path. `flush()` is for the explicit
 * force-flush triggers (session end, deletion confirm, before-quit).
 */
export class DecisionsStore {
  private file: DecisionsFile
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(initial: DecisionsFile) {
    this.file = initial
  }

  getAll(): DecisionsFile {
    return this.file
  }

  get(trackId: string): DecisionEntry | undefined {
    return this.file.d[trackId]
  }

  set(trackId: string, entry: DecisionEntry | undefined): void {
    if (entry === undefined) delete this.file.d[trackId]
    else this.file.d[trackId] = entry
    this.dirty = true
    this.scheduleFlush()
  }

  /** A keep/delete decision was made (track:decide). Lifetime counter, per spec §6.8. */
  recordDecision(): void {
    const stats = this.file.stats
    if (stats.firstReviewAt === null) stats.firstReviewAt = new Date().toISOString()
    stats.totalReviewed++
    this.dirty = true
    this.scheduleFlush()
  }

  /** A decision was undone — mirrors recordDecision so the lifetime count nets out correctly. */
  recordUndo(): void {
    this.file.stats.totalReviewed = Math.max(0, this.file.stats.totalReviewed - 1)
    this.dirty = true
    this.scheduleFlush()
  }

  recordDisposal(mode: 'trashed' | 'moved', bytes: number): void {
    const stats = this.file.stats
    if (mode === 'trashed') {
      stats.totalTrashed++
      stats.bytesReclaimed += bytes
    } else {
      stats.totalMoved++
      stats.bytesMoved += bytes
    }
    this.dirty = true
    this.scheduleFlush()
  }

  recordSessionCompleted(): void {
    this.file.stats.sessionsCompleted++
    this.dirty = true
    this.scheduleFlush()
  }

  /** Swaps in a whole new file (e.g. after a rescan's reconciliation) without writing again. */
  replace(file: DecisionsFile): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.file = file
    this.dirty = false
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, DEBOUNCE_MS)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const snapshot = this.file
    this.writeChain = this.writeChain.then(() => writeJsonAtomic(getDecisionsFilePath(), snapshot))
    await this.writeChain
  }
}
