import { describe, expect, it } from 'vitest'
import { buildQueue } from './queue'
import type { DecisionEntry, Track } from '../../shared/types'

function track(overrides: Partial<Track> & { path: string; birthtimeMs: number }): Track {
  return {
    size: 1000,
    mtimeMs: 0,
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

function decision(overrides: Partial<DecisionEntry> & { s: DecisionEntry['s'] }): DecisionEntry {
  return { r: 0, n: 1, ...overrides }
}

describe('buildQueue', () => {
  it('orders pass 1 (unreviewed) by birthtimeMs ascending, tiebroken by path', () => {
    const tracks: Record<string, Track> = {
      t1: track({ path: 'c', birthtimeMs: 300 }),
      t2: track({ path: 'a', birthtimeMs: 100 }),
      t3: track({ path: 'b1', birthtimeMs: 200 }),
      t4: track({ path: 'b0', birthtimeMs: 200 })
    }

    expect(buildQueue(tracks, {})).toEqual(['t2', 't4', 't3', 't1'])
  })

  it('orders pass 2 (kept) by reviewedAt ascending, tiebroken by birthtimeMs', () => {
    const tracks: Record<string, Track> = {
      t1: track({ path: 'a', birthtimeMs: 500 }),
      t2: track({ path: 'b', birthtimeMs: 100 }),
      t3: track({ path: 'c', birthtimeMs: 300 })
    }
    const decisions: Record<string, DecisionEntry> = {
      t1: decision({ s: 'keep', r: 50 }),
      t2: decision({ s: 'keep', r: 10 }),
      t3: decision({ s: 'keep', r: 10 })
    }

    // t2 and t3 tie on r=10, so birthtimeMs (100 < 300) breaks the tie.
    expect(buildQueue(tracks, decisions)).toEqual(['t2', 't3', 't1'])
  })

  it('exhausts pass 1 before any pass-2 (kept) track appears', () => {
    const tracks: Record<string, Track> = {
      unreviewed: track({ path: 'z', birthtimeMs: 999 }),
      kept: track({ path: 'a', birthtimeMs: 1 })
    }
    const decisions: Record<string, DecisionEntry> = {
      kept: decision({ s: 'keep', r: 0 })
    }

    expect(buildQueue(tracks, decisions)).toEqual(['unreviewed', 'kept'])
  })

  it('excludes delete, trashed, missing, and moved tracks entirely', () => {
    const tracks: Record<string, Track> = {
      del: track({ path: 'a', birthtimeMs: 1 }),
      trashed: track({ path: 'b', birthtimeMs: 2 }),
      missing: track({ path: 'c', birthtimeMs: 3 }),
      moved: track({ path: 'd', birthtimeMs: 4 }),
      kept: track({ path: 'e', birthtimeMs: 5 })
    }
    const decisions: Record<string, DecisionEntry> = {
      del: decision({ s: 'delete' }),
      trashed: decision({ s: 'trashed' }),
      missing: decision({ s: 'missing' }),
      moved: decision({ s: 'moved' }),
      kept: decision({ s: 'keep' })
    }

    expect(buildQueue(tracks, decisions)).toEqual(['kept'])
  })
})
