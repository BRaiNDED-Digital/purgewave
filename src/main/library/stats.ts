import type { DecisionsFile, LibraryFile, LifetimeStats, WeeklyBucket } from '../../shared/types'

function weekStartIso(epochMs: number): string {
  const d = new Date(epochMs)
  const day = d.getUTCDay()
  const diffToMonday = (day + 6) % 7
  d.setUTCDate(d.getUTCDate() - diffToMonday)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

/**
 * Everything here is derived from counters/fields already maintained elsewhere (§6.8: "no new
 * tracking infrastructure") — `weeklyReviewed` in particular is a bucketing of each track's
 * current `r` (last reviewedAt) timestamp, not a separate event log, so a track re-reviewed
 * since only counts in the week of its *latest* decision.
 */
export function computeLifetimeStats(library: LibraryFile | null, decisions: DecisionsFile): LifetimeStats {
  const d = decisions.d
  const entries = Object.values(d)

  const totalKept = entries.filter((e) => e.s === 'keep').length
  const totalPendingDelete = entries.filter((e) => e.s === 'delete').length
  const totalDisposed = decisions.stats.totalTrashed + decisions.stats.totalMoved
  const totalDecided = totalKept + totalPendingDelete + totalDisposed
  const keepRate = totalDecided > 0 ? totalKept / totalDecided : 0

  const libraryTotal = library ? Object.keys(library.tracks).length : 0
  const libraryUnreviewed = library
    ? Object.keys(library.tracks).filter((id) => !d[id]).length
    : 0
  const percentTriaged = libraryTotal > 0 ? (libraryTotal - libraryUnreviewed) / libraryTotal : 0

  const buckets = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.r) continue
    const key = weekStartIso(entry.r)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const weeklyReviewed: WeeklyBucket[] = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStartIso, count]) => ({ weekStartIso, count }))

  return {
    totalReviewed: decisions.stats.totalReviewed,
    totalKept,
    totalPendingDelete,
    totalDisposed,
    keepRate,
    bytesReclaimed: decisions.stats.bytesReclaimed,
    bytesMoved: decisions.stats.bytesMoved,
    libraryTotal,
    libraryUnreviewed,
    percentTriaged,
    sessionsCompleted: decisions.stats.sessionsCompleted,
    reviewingSinceAt: decisions.stats.firstReviewAt,
    weeklyReviewed
  }
}

// exported for tests only
export const _internal = { weekStartIso }
