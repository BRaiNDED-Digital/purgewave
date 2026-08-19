import { dirname } from 'node:path'
import type { DecisionEntry, DecisionsFile, LibraryFile, ScanResult, Track } from '../../shared/types'

/**
 * What the walk+tag-read phase found for one file this scan. Same shape as a Track record
 * minus the two fields reconciliation itself is responsible for computing (`lastSeenScan`,
 * `dupOf`).
 */
export type FreshFileEntry = Omit<Track, 'lastSeenScan' | 'dupOf'>

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

export interface ReconcileInput {
  musicRoot: string
  previousLibrary: LibraryFile | null
  previousDecisions: DecisionsFile
  /** null = the root itself could not be read (§3.5 guard); the scan never ran. */
  freshEntries: FreshFileEntry[] | null
  scanSeq: number
  /** Injectable for tests; defaults to Date.now(). */
  now?: number
}

export interface ReconcileSuccess {
  aborted: false
  library: LibraryFile
  decisions: DecisionsFile
  result: ScanResult
}

export interface ReconcileAborted {
  aborted: true
  reason: 'unreadable-root' | 'empty-scan'
}

export type ReconcileResult = ReconcileSuccess | ReconcileAborted

/**
 * Pure diff/merge of a fresh disk walk against the previous index, per spec §3.4–§3.6.
 * No fs or Electron imports on purpose — this is the logic most worth unit-testing without
 * booting a window, and the guards here are the most important thing in the whole app to get
 * right: getting them wrong in the destructive direction costs years of review history.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { musicRoot, previousLibrary, previousDecisions, freshEntries, scanSeq } = input
  const now = input.now ?? Date.now()

  if (freshEntries === null) return { aborted: true, reason: 'unreadable-root' }

  const prevTracks = previousLibrary?.tracks ?? {}
  const hadTracks = Object.keys(prevTracks).length > 0
  if (freshEntries.length === 0 && hadTracks) return { aborted: true, reason: 'empty-scan' }

  const prevByFp = new Map<string, string[]>()
  for (const [id, t] of Object.entries(prevTracks)) {
    const list = prevByFp.get(t.fp)
    if (list) list.push(id)
    else prevByFp.set(t.fp, [id])
  }

  const usedPrevIds = new Set<string>()
  function claimPrevId(fp: string, path: string): string | undefined {
    const candidates = prevByFp.get(fp)
    if (!candidates) return undefined
    const exact = candidates.find((id) => !usedPrevIds.has(id) && prevTracks[id].path === path)
    if (exact) {
      usedPrevIds.add(exact)
      return exact
    }
    const any = candidates.find((id) => !usedPrevIds.has(id))
    if (any) {
      usedPrevIds.add(any)
      return any
    }
    return undefined
  }

  const tracks: Record<string, Track> = { ...prevTracks }
  const decisionsD: Record<string, DecisionEntry> = { ...previousDecisions.d }
  let nextId = previousLibrary?.nextId ?? 1

  const matchedIds = new Set<string>()
  const firstIdForFpThisScan = new Map<string, string>()

  let added = 0
  let updated = 0
  let newlyMissing = 0

  const sorted = [...freshEntries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  for (const entry of sorted) {
    const prevId = claimPrevId(entry.fp, entry.path)
    const id = prevId ?? `t${nextId++}`

    const firstThisScan = firstIdForFpThisScan.get(entry.fp)
    const dupOf = firstThisScan === undefined ? undefined : firstThisScan
    if (firstThisScan === undefined) firstIdForFpThisScan.set(entry.fp, id)

    tracks[id] = { ...entry, lastSeenScan: scanSeq, dupOf }
    matchedIds.add(id)

    if (prevId === undefined) {
      added++
      continue
    }

    const prevTrack = prevTracks[prevId]
    if (prevTrack.size !== entry.size || prevTrack.mtimeMs !== entry.mtimeMs || prevTrack.path !== entry.path) {
      updated++
    }

    const decision = decisionsD[id]
    if (decision?.s === 'missing') {
      // A missing (or never-reviewed) track reappeared: restore exactly what it was. Both
      // `was` and `x` (the missing-since stamp) are stale once restored — `x` on a non-missing
      // entry means trashedAt/movedAt, so leaving it behind would misrepresent a live 'keep'/
      // 'delete' entry as having been disposed of.
      if (decision.was && decision.was !== 'unreviewed') {
        const { was: _was, x: _x, ...rest } = decision
        decisionsD[id] = { ...rest, s: decision.was }
      } else {
        delete decisionsD[id]
      }
      updated++
    } else if (decision?.s === 'trashed' || decision?.s === 'moved') {
      // Deliberate reversal (restored from the Recycle Bin, or moved back by hand): back to
      // unreviewed rather than resurrecting the old decision. Per §5.1, pass 1 is strictly
      // "no decisions entry" — there is no schema slot to keep `n` while also being pass-1
      // eligible, so the entry is dropped entirely rather than partially preserved.
      delete decisionsD[id]
      updated++
    }
  }

  // Anything previously known but not found this scan: missing, unless it was already
  // trashed/moved (files disposed of are *expected* to be gone, that's not an event).
  let autoForgotten = 0
  for (const [id] of Object.entries(prevTracks)) {
    if (matchedIds.has(id)) continue
    const decision = decisionsD[id]
    if (decision?.s === 'trashed' || decision?.s === 'moved') continue

    if (decision?.s === 'missing') {
      // §3.6: the one sanctioned automatic prune — a full year unseen is long enough that a
      // forgotten external drive has had every reasonable chance to reappear. Never applies to
      // trashed/moved (excluded above) or to anything the user hasn't already let go missing.
      if (decision.x !== undefined && now - decision.x >= ONE_YEAR_MS) {
        delete decisionsD[id]
        delete tracks[id]
        autoForgotten++
      }
      continue
    }

    const priorStatus = decision?.s ?? 'unreviewed'
    decisionsD[id] = { s: 'missing', was: priorStatus, r: decision?.r ?? 0, n: decision?.n ?? 0, x: now }
    newlyMissing++
  }

  const folders: LibraryFile['folders'] = {}
  for (const id of matchedIds) {
    const folder = dirname(tracks[id].path)
    if (!folders[folder]) folders[folder] = { ids: [], art: null }
    folders[folder].ids.push(id)
  }

  const library: LibraryFile = {
    schemaVersion: 1,
    musicRoot,
    lastScanAt: new Date().toISOString(),
    nextId,
    scanSeq,
    folders,
    tracks
  }

  const decisions: DecisionsFile = { ...previousDecisions, d: decisionsD }

  const result: ScanResult = {
    added,
    updated,
    missing: newlyMissing,
    pruned: autoForgotten,
    // NOT Object.keys(tracks).length — `tracks` never shrinks when the root changes (§3.6: no
    // automatic pruning), so that would keep counting every track from every root ever pointed
    // at, including ones now `missing` because they belong to a folder that's no longer mapped.
    // Also excludes `trashed`/`moved`: those records are deliberately never marked `missing`
    // (disposal is expected to make the file disappear, not an error worth flagging — see the
    // `continue` for those statuses above), so without this exclusion a purged track would stay
    // counted forever, making the total look like it never goes down after purging. "Tracks
    // indexed" should mean tracks actually still present under the *current* root.
    total: Object.keys(tracks).filter((id) => {
      const s = decisionsD[id]?.s
      return s !== 'missing' && s !== 'trashed' && s !== 'moved'
    }).length
  }

  return { aborted: false, library, decisions, result }
}
