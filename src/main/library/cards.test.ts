import { describe, expect, it } from 'vitest'
import { buildCard } from './cards'
import type { DecisionEntry, FolderEntry, Track } from '../../shared/types'

function track(overrides: Partial<Track> & { path: string }): Track {
  return {
    size: 1000,
    mtimeMs: 0,
    birthtimeMs: 0,
    title: overrides.path,
    artist: '',
    album: 'Some Album',
    trackNo: null,
    year: null,
    durationSec: 180,
    bitrate: null,
    format: 'mp3',
    hasArtwork: false,
    artPath: null,
    replayGainDb: null,
    fp: `fp-${overrides.path}`,
    lastSeenScan: 1,
    ...overrides
  }
}

describe('buildCard', () => {
  it('computes album context position, total, and marked-for-deletion count', () => {
    const tracks: Record<string, Track> = {
      t1: track({ path: '/music/a/01.mp3', trackNo: 1 }),
      t2: track({ path: '/music/a/02.mp3', trackNo: 2 }),
      t3: track({ path: '/music/a/03.mp3', trackNo: 3 })
    }
    const folders: Record<string, FolderEntry> = { '/music/a': { ids: ['t1', 't2', 't3'], art: null } }
    const decisions: Record<string, DecisionEntry> = { t3: { s: 'delete', r: 0, n: 1 } }

    const card = buildCard('t2', tracks, folders, decisions)

    expect(card.albumContext).toEqual({ index: 2, total: 3, albumName: 'Some Album', markedForDeletion: 1 })
  })

  it('omits album context for a track alone in its folder', () => {
    const tracks: Record<string, Track> = { t1: track({ path: '/music/solo/01.mp3' }) }
    const folders: Record<string, FolderEntry> = { '/music/solo': { ids: ['t1'], art: null } }

    const card = buildCard('t1', tracks, folders, {})

    expect(card.albumContext).toBeNull()
  })

  it('surfaces pastReview only for kept (pass-2) tracks', () => {
    const tracks: Record<string, Track> = { t1: track({ path: '/music/a/01.mp3' }) }
    const decisions: Record<string, DecisionEntry> = { t1: { s: 'keep', r: 555, n: 3 } }

    const card = buildCard('t1', tracks, {}, decisions)

    expect(card.pastReview).toEqual({ lastReviewedAt: 555, reviewCount: 3 })
  })

  it('leaves pastReview null for an unreviewed or non-kept track', () => {
    const tracks: Record<string, Track> = { t1: track({ path: '/music/a/01.mp3' }) }

    expect(buildCard('t1', tracks, {}, {}).pastReview).toBeNull()
    expect(buildCard('t1', tracks, {}, { t1: { s: 'delete', r: 1, n: 1 } }).pastReview).toBeNull()
  })
})
