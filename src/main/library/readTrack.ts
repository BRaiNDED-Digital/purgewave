import { stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { computeFingerprint } from './fingerprint'
import { extractArtwork } from './artwork'
import type { Track } from '../../shared/types'

// music-metadata ships ESM-only; the main bundle is CJS, so it must be loaded via dynamic import.
async function parseFile(path: string) {
  const { parseFile } = await import('music-metadata')
  return parseFile(path, { duration: true })
}

export interface ReadTrackResult {
  track: Omit<Track, 'lastSeenScan'>
  folder: string
}

export async function readTrack(path: string, artDir: string): Promise<ReadTrackResult> {
  const stats = await stat(path)
  const format = extname(path).slice(1).toLowerCase()

  let title = basename(path)
  let artist = ''
  let album = ''
  let trackNo: number | null = null
  let year: number | null = null
  let durationSec = 0
  let bitrate: number | null = null
  let embeddedArtBuffer: Buffer | null = null
  let replayGainDb: number | null = null
  let decodable = true

  try {
    const metadata = await parseFile(path)
    const { common, format: fmt } = metadata
    title = common.title ?? title
    artist = common.artist ?? artist
    album = common.album ?? album
    trackNo = common.track?.no ?? null
    year = common.year ?? null
    durationSec = fmt.duration ?? 0
    bitrate = fmt.bitrate ? Math.round(fmt.bitrate) : null

    const picture = common.picture?.[0]
    if (picture) embeddedArtBuffer = Buffer.from(picture.data)

    const gain = common.replaygain_track_gain
    if (gain && typeof gain.dB === 'number') replayGainDb = gain.dB
  } catch {
    decodable = false
  }

  const fp = await computeFingerprint(path, stats.size, durationSec)

  const artPath = await extractArtwork({
    fp,
    artDir,
    embeddedArtBuffer,
    trackDir: dirname(path)
  })

  const track: Omit<Track, 'lastSeenScan'> = {
    path,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
    title,
    artist,
    album,
    trackNo,
    year,
    durationSec,
    bitrate,
    format,
    hasArtwork: embeddedArtBuffer !== null || artPath !== null,
    artPath,
    replayGainDb,
    fp,
    previewUnsupported: format === 'wma' || !decodable,
    titleIsFilenameFallback: title === basename(path)
  }

  return { track, folder: dirname(path) }
}
