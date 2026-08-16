import type { DecisionsFile, DormantTrack, LibraryFile } from '../../shared/types'

/**
 * Candidates for the manual "Forget dormant tracks" settings action (§3.6): missing records not
 * seen in at least `minScansUnseen` scans (default 20). Never includes trashed/moved records —
 * those are excluded by construction since only `missing` entries are considered.
 */
export function findDormantTracks(
  library: LibraryFile,
  decisions: DecisionsFile,
  minScansUnseen = 20
): DormantTrack[] {
  const result: DormantTrack[] = []
  for (const [id, entry] of Object.entries(decisions.d)) {
    if (entry.s !== 'missing') continue
    const track = library.tracks[id]
    if (!track) continue
    const scansUnseen = library.scanSeq - track.lastSeenScan
    if (scansUnseen < minScansUnseen) continue
    result.push({ id, title: track.title, artist: track.artist, path: track.path, scansUnseen })
  }
  return result.sort((a, b) => b.scansUnseen - a.scansUnseen)
}
