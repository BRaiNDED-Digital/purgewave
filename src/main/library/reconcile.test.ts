import { describe, expect, it } from 'vitest'
import { reconcile, type FreshFileEntry } from './reconcile'
import type { DecisionEntry, DecisionsFile, LibraryFile, Track } from '../../shared/types'
import { createEmptyDecisionsFile } from '../../shared/types'

function track(overrides: Partial<Track> & { path: string; fp: string }): Track {
  return {
    size: 1000,
    mtimeMs: 1000,
    birthtimeMs: 1000,
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
    lastSeenScan: 1,
    ...overrides
  }
}

function fresh(overrides: Partial<FreshFileEntry> & { path: string; fp: string }): FreshFileEntry {
  const { path, fp, ...rest } = track(overrides)
  return { path, fp, ...rest }
}

function library(tracks: Record<string, Track>, opts: Partial<LibraryFile> = {}): LibraryFile {
  return {
    schemaVersion: 1,
    musicRoot: '/music',
    lastScanAt: null,
    nextId: Object.keys(tracks).length + 1,
    scanSeq: 1,
    folders: {},
    tracks,
    ...opts
  }
}

function decisionsFile(d: Record<string, DecisionEntry>): DecisionsFile {
  return { ...createEmptyDecisionsFile(), d }
}

describe('reconcile', () => {
  it('keeps status when a file is renamed in place', () => {
    const prev = library({ t1: track({ path: '/music/a/old.mp3', fp: 'X' }) })
    const decisions = decisionsFile({ t1: { s: 'keep', r: 5, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/a/new.mp3', fp: 'X' })],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.library.tracks.t1.path).toBe('/music/a/new.mp3')
    expect(out.decisions.d.t1).toEqual({ s: 'keep', r: 5, n: 1 })
    expect(out.library.tracks.t1.lastSeenScan).toBe(2)
  })

  it('keeps status when a file moves to a different folder', () => {
    const prev = library({ t1: track({ path: '/music/Old Album/track.mp3', fp: 'X' }) })
    const decisions = decisionsFile({ t1: { s: 'delete', r: 5, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/New Album/track.mp3', fp: 'X' })],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.library.tracks.t1.path).toBe('/music/New Album/track.mp3')
    expect(out.decisions.d.t1.s).toBe('delete')
  })

  it('preserves every status when the whole tree is reorganized at once', () => {
    const prev = library({
      t1: track({ path: '/music/a1.mp3', fp: 'A' }),
      t2: track({ path: '/music/b1.mp3', fp: 'B' }),
      t3: track({ path: '/music/c1.mp3', fp: 'C' })
    })
    const decisions = decisionsFile({
      t1: { s: 'keep', r: 1, n: 1 },
      t2: { s: 'delete', r: 2, n: 1 }
      // t3 intentionally unreviewed (no entry)
    })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [
        fresh({ path: '/music/reorg/a2.mp3', fp: 'A' }),
        fresh({ path: '/music/reorg/b2.mp3', fp: 'B' }),
        fresh({ path: '/music/reorg/c2.mp3', fp: 'C' })
      ],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.library.tracks.t1.path).toBe('/music/reorg/a2.mp3')
    expect(out.library.tracks.t2.path).toBe('/music/reorg/b2.mp3')
    expect(out.library.tracks.t3.path).toBe('/music/reorg/c2.mp3')
    expect(out.decisions.d.t1.s).toBe('keep')
    expect(out.decisions.d.t2.s).toBe('delete')
    expect(out.decisions.d.t3).toBeUndefined()
  })

  it('refreshes metadata on a tag edit (mtimeMs changes) without touching fp or status', () => {
    const prev = library({ t1: track({ path: '/music/a.mp3', fp: 'X', mtimeMs: 1000, title: 'Old Title' }) })
    const decisions = decisionsFile({ t1: { s: 'keep', r: 5, n: 2 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/a.mp3', fp: 'X', mtimeMs: 2000, title: 'New Title' })],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.library.tracks.t1.fp).toBe('X')
    expect(out.library.tracks.t1.title).toBe('New Title')
    expect(out.decisions.d.t1).toEqual({ s: 'keep', r: 5, n: 2 })
    expect(out.result.updated).toBe(1)
  })

  it('marks a deleted (vanished) file as missing, remembering its prior status', () => {
    // A second, unrelated track stays present so this scan isn't "found zero files" (which
    // would correctly trip the empty-scan guard instead) — only t1's file has vanished.
    const prev = library({
      t1: track({ path: '/music/a.mp3', fp: 'X' }),
      t2: track({ path: '/music/still-here.mp3', fp: 'Y' })
    })
    const decisions = decisionsFile({ t1: { s: 'delete', r: 5, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/still-here.mp3', fp: 'Y' })],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.decisions.d.t1).toMatchObject({ s: 'missing', was: 'delete', r: 5, n: 1 })
    expect(out.library.tracks.t1).toBeDefined() // record is kept, not pruned
    expect(out.result.missing).toBe(1)
  })

  it('restores a missing file to its prior status when it reappears at a new path', () => {
    const prev = library({ t1: track({ path: '/music/a.mp3', fp: 'X' }) })
    const decisions = decisionsFile({ t1: { s: 'missing', was: 'delete', r: 5, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/found-again.mp3', fp: 'X' })],
      scanSeq: 3
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.decisions.d.t1).toEqual({ s: 'delete', r: 5, n: 1 })
    expect(out.library.tracks.t1.path).toBe('/music/found-again.mp3')
  })

  it('returns a restored-from-Recycle-Bin (trashed) file to unreviewed', () => {
    const prev = library({ t1: track({ path: '/music/a.mp3', fp: 'X' }) })
    const decisions = decisionsFile({ t1: { s: 'trashed', r: 5, n: 1, x: 999 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/a.mp3', fp: 'X' })],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.decisions.d.t1).toBeUndefined()
  })

  it('aborts with zero mutations when the root is unreadable', () => {
    const prev = library({ t1: track({ path: '/music/a.mp3', fp: 'X' }) })
    const decisions = decisionsFile({ t1: { s: 'keep', r: 5, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: null,
      scanSeq: 2
    })

    expect(out).toEqual({ aborted: true, reason: 'unreadable-root' })
  })

  it('aborts a zero-file scan against a non-empty index rather than treating it as a mass deletion', () => {
    const prev = library({ t1: track({ path: '/music/a.mp3', fp: 'X' }) })
    const decisions = decisionsFile({ t1: { s: 'keep', r: 5, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [],
      scanSeq: 2
    })

    expect(out).toEqual({ aborted: true, reason: 'empty-scan' })
  })

  it('does not abort a zero-file scan when the index was already empty (first run against an empty folder)', () => {
    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: null,
      previousDecisions: createEmptyDecisionsFile(),
      freshEntries: [],
      scanSeq: 1
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.result.total).toBe(0)
  })

  it('rebases every matching fingerprint onto a new root without losing status', () => {
    const prev = library(
      { t1: track({ path: '/old-drive/a.mp3', fp: 'X' }) },
      { musicRoot: '/old-drive' }
    )
    const decisions = decisionsFile({ t1: { s: 'keep', r: 5, n: 3 } })

    const out = reconcile({
      musicRoot: '/new-drive',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/new-drive/a.mp3', fp: 'X' })],
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.library.musicRoot).toBe('/new-drive')
    expect(out.library.tracks.t1.path).toBe('/new-drive/a.mp3')
    expect(out.decisions.d.t1.s).toBe('keep')
  })

  it('leaves siblings dormant when pointed at a subfolder, and revives them when the parent is reselected', () => {
    const prev = library({
      t1: track({ path: '/music/RockAlbum/a.mp3', fp: 'A' }),
      t2: track({ path: '/music/JazzAlbum/b.mp3', fp: 'B' })
    })
    const decisions = decisionsFile({
      t1: { s: 'keep', r: 1, n: 1 },
      t2: { s: 'keep', r: 2, n: 1 }
    })

    const subfolderScan = reconcile({
      musicRoot: '/music/RockAlbum',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/RockAlbum/a.mp3', fp: 'A' })],
      scanSeq: 2
    })
    expect(subfolderScan.aborted).toBe(false)
    if (subfolderScan.aborted) return
    expect(subfolderScan.decisions.d.t1.s).toBe('keep')
    expect(subfolderScan.decisions.d.t2).toMatchObject({ s: 'missing', was: 'keep' })
    // The dormant record itself is kept, not pruned.
    expect(subfolderScan.library.tracks.t2).toBeDefined()

    const parentScanAgain = reconcile({
      musicRoot: '/music',
      previousLibrary: subfolderScan.library,
      previousDecisions: subfolderScan.decisions,
      freshEntries: [
        fresh({ path: '/music/RockAlbum/a.mp3', fp: 'A' }),
        fresh({ path: '/music/JazzAlbum/b.mp3', fp: 'B' })
      ],
      scanSeq: 3
    })
    expect(parentScanAgain.aborted).toBe(false)
    if (parentScanAgain.aborted) return
    expect(parentScanAgain.decisions.d.t2).toEqual({ s: 'keep', r: 2, n: 1 })
  })

  it('never prunes a previously-known record without an explicit user action', () => {
    const prev = library({
      t1: track({ path: '/music/a.mp3', fp: 'A' }),
      t2: track({ path: '/music/b.mp3', fp: 'B' })
    })
    const decisions = decisionsFile({ t1: { s: 'keep', r: 1, n: 1 } })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/a.mp3', fp: 'A' })], // b.mp3 vanished
      scanSeq: 2
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(Object.keys(prev.tracks).every((id) => id in out.library.tracks)).toBe(true)
  })

  it('keeps duplicate files (same fingerprint) as separate ids, marking the later ones dupOf the first', () => {
    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: null,
      previousDecisions: createEmptyDecisionsFile(),
      freshEntries: [
        fresh({ path: '/music/copy1.mp3', fp: 'DUP' }),
        fresh({ path: '/music/copy2.mp3', fp: 'DUP' })
      ],
      scanSeq: 1
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    const ids = Object.keys(out.library.tracks)
    expect(ids).toHaveLength(2)
    const [firstId, secondId] = ids
    expect(out.library.tracks[firstId].dupOf).toBeUndefined()
    expect(out.library.tracks[secondId].dupOf).toBe(firstId)
  })

  it('stamps a missing-since timestamp when a file first vanishes', () => {
    const prev = library({
      t1: track({ path: '/music/a.mp3', fp: 'A' }),
      t2: track({ path: '/music/b.mp3', fp: 'B' })
    })
    const now = 1_700_000_000_000

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: createEmptyDecisionsFile(),
      freshEntries: [fresh({ path: '/music/a.mp3', fp: 'A' })],
      scanSeq: 2,
      now
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.decisions.d.t2).toMatchObject({ s: 'missing', x: now })
  })

  it('auto-forgets a record missing for a full year, but not one missing for less', () => {
    const now = 1_700_000_000_000
    const oneYearMs = 365 * 24 * 60 * 60 * 1000
    const prev = library({
      old: track({ path: '/music/old.mp3', fp: 'OLD' }),
      recent: track({ path: '/music/recent.mp3', fp: 'RECENT' }),
      present: track({ path: '/music/present.mp3', fp: 'PRESENT' })
    })
    const decisions = decisionsFile({
      old: { s: 'missing', was: 'keep', r: 1, n: 1, x: now - oneYearMs },
      recent: { s: 'missing', was: 'keep', r: 1, n: 1, x: now - oneYearMs + 1000 }
    })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      // A present file keeps this from being a zero-file scan (§3.5 guard) — old/recent stay absent.
      freshEntries: [fresh({ path: '/music/present.mp3', fp: 'PRESENT' })],
      scanSeq: 2,
      now
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.decisions.d.old).toBeUndefined()
    expect(out.library.tracks.old).toBeUndefined()
    expect(out.decisions.d.recent).toBeDefined()
    expect(out.library.tracks.recent).toBeDefined()
    expect(out.result.pruned).toBe(1)
  })

  it('never auto-forgets a trashed or moved record, regardless of age', () => {
    const now = 1_700_000_000_000
    const oneYearMs = 365 * 24 * 60 * 60 * 1000
    const prev = library({
      t1: track({ path: '/music/a.mp3', fp: 'A' }),
      t2: track({ path: '/music/b.mp3', fp: 'B' }),
      present: track({ path: '/music/present.mp3', fp: 'PRESENT' })
    })
    const decisions = decisionsFile({
      t1: { s: 'trashed', r: 1, n: 1, x: now - oneYearMs * 5 },
      t2: { s: 'moved', r: 1, n: 1, x: now - oneYearMs * 5, movedTo: '/quarantine/b.mp3' }
    })

    const out = reconcile({
      musicRoot: '/music',
      previousLibrary: prev,
      previousDecisions: decisions,
      freshEntries: [fresh({ path: '/music/present.mp3', fp: 'PRESENT' })],
      scanSeq: 2,
      now
    })

    expect(out.aborted).toBe(false)
    if (out.aborted) return
    expect(out.decisions.d.t1.s).toBe('trashed')
    expect(out.decisions.d.t2.s).toBe('moved')
    expect(out.result.pruned).toBe(0)
  })
})
