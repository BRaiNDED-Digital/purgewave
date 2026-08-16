import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { LibraryFile } from '../../shared/types'

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.alac': 'audio/mp4'
}

/**
 * Serves audio to the renderer by track ID rather than raw path (spec §6.5): the renderer can
 * only ever request an ID it was already handed via session:getCards, which sidesteps the whole
 * path-traversal surface a raw-path protocol would need to validate against the library root.
 * Range support (206 + Content-Range) is the single biggest latency risk per §3.7 rule 4 — without
 * it, seeking into a large FLAC transfers the whole file first.
 */
export function registerTrackProtocolHandler(getLibrary: () => LibraryFile | null): void {
  protocol.handle('track', async (request) => {
    const id = new URL(request.url).hostname
    const track = getLibrary()?.tracks[id]
    if (!track) return new Response('Not found', { status: 404 })

    let stats
    try {
      stats = await stat(track.path)
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const mime = MIME_TYPES[extname(track.path).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('range')

    if (!range) {
      const stream = Readable.toWeb(createReadStream(track.path)) as NodeWebReadableStream
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(stats.size),
          'Accept-Ranges': 'bytes'
        }
      })
    }

    const match = /bytes=(\d+)-(\d*)/.exec(range)
    if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stats.size}` } })

    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1
    if (start >= stats.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stats.size}` } })
    }

    const stream = Readable.toWeb(createReadStream(track.path, { start, end })) as NodeWebReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1)
      }
    })
  })
}
