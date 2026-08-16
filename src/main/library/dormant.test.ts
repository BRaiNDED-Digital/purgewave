import { describe, expect, it } from 'vitest'
import { findDormantTracks } from './dormant'
import type { DecisionEntry, LibraryFile, Track } from '../../shared/types'
import { createEmptyDecisionsFile } from '../../shared/types'

function track(overrides: Partial<Track> & { path: string; lastSeenScan: number }): Track {
  return {
    size: 1000,
    mtimeMs: 0,
    birthtimeMs: 0,
    title: overrides.path,
    artist: 'Someone',
    album: '',
    trackNo: null,
    year: null,
    durationSec: 180,
    bitrate: null,
    format: 'mp3',
    hasArtwork: false,
    artPath: null,
    replayGainDb: null,
    fp: `fp-${overrides.path}`,
    ...overrides
  }
}

function library(tracks: Record<string, Track>, scanSeq: number): LibraryFile {
  return {
    schemaVersion: 1,
    musicRoot: '/music',
    lastScanAt: null,
    nextId: Object.keys(tracks).length + 1,
    scanSeq,
    folders: {},
    tracks
  }
}

describe('findDormantTracks', () => {
  it('includes missing tracks unseen for at least the threshold, excludes those seen more recently', () => {
    const lib = library(
      {
        old: track({ path: '/music/old.mp3', lastSeenScan: 1 }),
        recent: track({ path: '/music/recent.mp3', lastSeenScan: 90 })
      },
      100
    )
    const decisions = {
      ...createEmptyDecisionsFile(),
      d: {
        old: { s: 'missing', was: 'keep', r: 0, n: 1 } as DecisionEntry,
        recent: { s: 'missing', was: 'keep', r: 0, n: 1 } as DecisionEntry
      }
    }

    const dormant = findDormantTracks(lib, decisions, 20)

    expect(dormant.map((t) => t.id)).toEqual(['old'])
    expect(dormant[0].scansUnseen).toBe(99)
  })

  it('never includes trashed or moved records', () => {
    const lib = library(
      { t1: track({ path: '/music/a.mp3', lastSeenScan: 1 }) },
      100
    )
    const decisions = {
      ...createEmptyDecisionsFile(),
      d: { t1: { s: 'trashed', r: 0, n: 1 } as DecisionEntry }
    }

    expect(findDormantTracks(lib, decisions, 20)).toEqual([])
  })

  it('sorts by longest-unseen first', () => {
    const lib = library(
      {
        a: track({ path: '/music/a.mp3', lastSeenScan: 50 }),
        b: track({ path: '/music/b.mp3', lastSeenScan: 1 })
      },
      100
    )
    const decisions = {
      ...createEmptyDecisionsFile(),
      d: {
        a: { s: 'missing', was: 'keep', r: 0, n: 1 } as DecisionEntry,
        b: { s: 'missing', was: 'keep', r: 0, n: 1 } as DecisionEntry
      }
    }

    const dormant = findDormantTracks(lib, decisions, 20)
    expect(dormant.map((t) => t.id)).toEqual(['b', 'a'])
  })
})
