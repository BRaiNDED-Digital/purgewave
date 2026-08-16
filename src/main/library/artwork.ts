import { readFile, readdir, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const FOLDER_ART_NAMES = ['cover', 'folder', 'front', 'album']
const FOLDER_ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp']

// One readdir per folder no matter how many tracks in it share that folder during a scan.
const folderArtCache = new Map<string, string | null>()

export async function resolveFolderArt(trackDir: string): Promise<string | null> {
  if (folderArtCache.has(trackDir)) return folderArtCache.get(trackDir) ?? null

  let entries: string[] = []
  try {
    entries = await readdir(trackDir)
  } catch {
    folderArtCache.set(trackDir, null)
    return null
  }

  const lowerToActual = new Map(entries.map((e) => [e.toLowerCase(), e]))
  let found: string | null = null
  outer: for (const name of FOLDER_ART_NAMES) {
    for (const ext of FOLDER_ART_EXTS) {
      const candidate = lowerToActual.get(`${name}${ext}`)
      if (candidate) {
        found = join(trackDir, candidate)
        break outer
      }
    }
  }

  folderArtCache.set(trackDir, found)
  return found
}

interface ExtractArtworkOptions {
  fp: string
  artDir: string
  embeddedArtBuffer: Buffer | null
  trackDir: string
}

/**
 * Resolves a track's artwork to a cached 600px webp thumbnail: embedded art first, then the
 * folder's cover/folder/front/album file. Skips re-extraction when the cache entry for this
 * fingerprint already exists, since fp only changes when the file's bytes change.
 */
export async function extractArtwork(opts: ExtractArtworkOptions): Promise<string | null> {
  const cachePath = join(opts.artDir, `${opts.fp}.webp`)

  try {
    await access(cachePath)
    return cachePath
  } catch {
    // not cached yet
  }

  let sourceBuffer: Buffer | null = opts.embeddedArtBuffer

  if (!sourceBuffer) {
    const folderArt = await resolveFolderArt(opts.trackDir)
    if (folderArt) {
      try {
        sourceBuffer = await readFile(folderArt)
      } catch {
        sourceBuffer = null
      }
    }
  }

  if (!sourceBuffer) return null

  try {
    await mkdir(opts.artDir, { recursive: true })
    await sharp(sourceBuffer)
      .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toFile(cachePath)
    return cachePath
  } catch {
    return null
  }
}

/**
 * Reads a cached art thumbnail into a data: URI for the renderer. Thumbnails are capped at
 * 600px/webp so this stays cheap even across a 50-card prefetch window (§3.7).
 */
export async function resolveArtDataUrl(artPath: string | null): Promise<string | null> {
  if (!artPath) return null
  try {
    const buf = await readFile(artPath)
    return `data:image/webp;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
