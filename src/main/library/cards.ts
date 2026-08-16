import { dirname } from 'node:path'
import type { Card, DecisionEntry, FolderEntry, Track } from '../../shared/types'

/**
 * Builds the display payload for one queue entry: metadata plus album context (§6.3) and
 * pass-2 review history. Pure — artwork resolution (a filesystem read) happens separately in
 * the IPC layer so this stays testable without touching disk.
 */
export function buildCard(
  id: string,
  tracks: Record<string, Track>,
  folders: Record<string, FolderEntry>,
  decisions: Record<string, DecisionEntry>
): Card {
  const track = tracks[id]
  const folder = folders[dirname(track.path)]

  let albumContext: Card['albumContext'] = null
  if (folder && folder.ids.length > 1) {
    const siblings = [...folder.ids].sort((a, b) => {
      const ta = tracks[a]
      const tb = tracks[b]
      if (ta.trackNo !== null && tb.trackNo !== null && ta.trackNo !== tb.trackNo) {
        return ta.trackNo - tb.trackNo
      }
      return ta.path < tb.path ? -1 : ta.path > tb.path ? 1 : 0
    })
    const index = siblings.indexOf(id)
    const markedForDeletion = siblings.filter((sid) => decisions[sid]?.s === 'delete').length
    albumContext = {
      index: index + 1,
      total: siblings.length,
      albumName: track.album || 'this folder',
      markedForDeletion
    }
  }

  const decision = decisions[id]
  const pastReview: Card['pastReview'] =
    decision && decision.s === 'keep' ? { lastReviewedAt: decision.r, reviewCount: decision.n } : null

  return {
    id,
    title: track.title,
    titleIsFilenameFallback: track.titleIsFilenameFallback ?? false,
    artist: track.artist,
    album: track.album,
    year: track.year,
    format: track.format,
    bitrate: track.bitrate,
    size: track.size,
    birthtimeMs: track.birthtimeMs,
    durationSec: track.durationSec,
    artDataUrl: null,
    previewUnsupported: track.previewUnsupported ?? false,
    albumContext,
    pastReview,
    replayGainDb: track.replayGainDb
  }
}
