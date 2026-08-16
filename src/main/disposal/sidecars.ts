import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

const SAME_BASENAME_EXTS = new Set(['.lrc', '.cue', '.txt', '.nfo', '.jpg', '.jpeg', '.png', '.webp'])
const ALBUM_ART_NAMES = new Set(['cover', 'folder', 'front', 'album'])
const ALBUM_ART_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

function stem(path: string): string {
  const ext = extname(path)
  return basename(path, ext)
}

/**
 * Same-basename companions (§6.7): files in the track's own directory that share its filename
 * stem — a `.lrc`/`.cue`/`.txt`/`.nfo`/cover image belonging to that track alone. Always follow
 * the track, regardless of siblings.
 */
export async function findSameBasenameSidecars(trackPath: string): Promise<string[]> {
  const dir = dirname(trackPath)
  const trackStem = stem(trackPath)
  const trackName = basename(trackPath)

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  return entries
    .filter((name) => name !== trackName && stem(name) === trackStem && SAME_BASENAME_EXTS.has(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
}

/**
 * Album art (`cover.*`/`folder.*`/`front.*`/`album.*`) follows the album out only when the
 * track being disposed of is the last remaining audio file in its directory — art attached to
 * an album should not vanish while siblings still need it.
 */
export async function findAlbumArtIfLastTrack(trackPath: string, remainingSiblingCount: number): Promise<string | null> {
  if (remainingSiblingCount > 0) return null

  const dir = dirname(trackPath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }

  for (const name of entries) {
    const ext = extname(name).toLowerCase()
    const base = stem(name).toLowerCase()
    if (ALBUM_ART_NAMES.has(base) && ALBUM_ART_EXTS.has(ext)) return join(dir, name)
  }
  return null
}
