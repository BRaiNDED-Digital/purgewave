import { describe, expect, it } from 'vitest'
import { computeLifetimeStats, _internal } from './stats'
import type { DecisionEntry, DecisionsFile, LibraryFile, Track } from '../../shared/types'
import { createEmptyDecisionsFile } from '../../shared/types'

function track(overrides: Partial<Track> & { path: string }): Track {
  return {
    size: 1000,
    mtimeMs: 0,
    birthtimeMs: 0,
    title: overrides.path,
    artist: '',
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
    lastSeenScan: 1,
    ...overrides
  }
}

function library(tracks: Record<string, Track>): LibraryFile {
  return {
    schemaVersion: 1,
    musicRoot: '/music',
    lastScanAt: null,
    nextId: Object.keys(tracks).length + 1,
    scanSeq: 1,
    folders: {},
    tracks
  }
}

function decisionsFile(d: Record<string, DecisionEntry>, statsOverrides: Partial<DecisionsFile['stats']> = {}): DecisionsFile {
  const base = createEmptyDecisionsFile()
  return { ...base, d, stats: { ...base.stats, ...statsOverrides } }
}

describe('_internal.weekStartIso', () => {
  it('buckets a mid-week timestamp to that week\'s Monday (UTC)', () => {
    // Wednesday 2026-01-14
    const wed = Date.UTC(2026, 0, 14, 15, 30)
    expect(_internal.weekStartIso(wed)).toBe('2026-01-12')
  })

  it('leaves a Monday unchanged', () => {
    const mon = Date.UTC(2026, 0, 12, 3, 0)
    expect(_internal.weekStartIso(mon)).toBe('2026-01-12')
  })
})

describe('computeLifetimeStats', () => {
  it('computes keep rate from current keep/delete/disposed counts', () => {
    const lib = library({
      t1: track({ path: '/music/a.mp3' }),
      t2: track({ path: '/music/b.mp3' }),
      t3: track({ path: '/music/c.mp3' }),
      t4: track({ path: '/music/d.mp3' })
    })
    const decisions = decisionsFile(
      {
        t1: { s: 'keep', r: 1, n: 1 },
        t2: { s: 'keep', r: 1, n: 1 },
        t3: { s: 'delete', r: 1, n: 1 }
        // t4 unreviewed
      },
      { totalTrashed: 1, totalMoved: 0, totalReviewed: 4 }
    )

    const stats = computeLifetimeStats(lib, decisions)

    expect(stats.totalKept).toBe(2)
    expect(stats.totalPendingDelete).toBe(1)
    expect(stats.totalDisposed).toBe(1)
    expect(stats.keepRate).toBeCloseTo(2 / 4)
    expect(stats.libraryTotal).toBe(4)
    expect(stats.libraryUnreviewed).toBe(1)
    expect(stats.percentTriaged).toBeCloseTo(3 / 4)
  })

  it('returns zero rates rather than dividing by zero on an empty library', () => {
    const stats = computeLifetimeStats(null, createEmptyDecisionsFile())
    expect(stats.keepRate).toBe(0)
    expect(stats.percentTriaged).toBe(0)
    expect(stats.libraryTotal).toBe(0)
  })

  it('buckets reviewed tracks into weeks by their current reviewedAt timestamp', () => {
    const wed1 = Date.UTC(2026, 0, 14)
    const wed2 = Date.UTC(2026, 0, 21)
    const decisions = decisionsFile({
      t1: { s: 'keep', r: wed1, n: 1 },
      t2: { s: 'keep', r: wed1, n: 1 },
      t3: { s: 'delete', r: wed2, n: 1 }
    })

    const stats = computeLifetimeStats(null, decisions)

    expect(stats.weeklyReviewed).toEqual([
      { weekStartIso: '2026-01-12', count: 2 },
      { weekStartIso: '2026-01-19', count: 1 }
    ])
  })
})
