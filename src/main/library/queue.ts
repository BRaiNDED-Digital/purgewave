import type { DecisionEntry, Track } from '../../shared/types'

/**
 * Two fixed passes per spec §5.1, computed once at session start:
 *   1. Unreviewed tracks (no decisions entry), oldest file first (birthtimeMs asc, path tiebreak).
 *   2. Previously-kept tracks, least-recently-reviewed first (reviewedAt asc, birthtimeMs tiebreak).
 * `delete`, `trashed`, `missing`, and `moved` tracks never appear in the queue. Pure and
 * Electron/fs-free on purpose — this is the logic most worth unit-testing without a window.
 */
export function buildQueue(tracks: Record<string, Track>, decisions: Record<string, DecisionEntry>): string[] {
  const unreviewed: string[] = []
  const kept: string[] = []

  for (const id of Object.keys(tracks)) {
    const decision = decisions[id]
    if (!decision) {
      unreviewed.push(id)
    } else if (decision.s === 'keep') {
      kept.push(id)
    }
    // delete / trashed / missing / moved: excluded
  }

  unreviewed.sort((a, b) => {
    const diff = tracks[a].birthtimeMs - tracks[b].birthtimeMs
    if (diff !== 0) return diff
    return tracks[a].path < tracks[b].path ? -1 : tracks[a].path > tracks[b].path ? 1 : 0
  })

  kept.sort((a, b) => {
    const diff = decisions[a].r - decisions[b].r
    if (diff !== 0) return diff
    return tracks[a].birthtimeMs - tracks[b].birthtimeMs
  })

  return [...unreviewed, ...kept]
}
