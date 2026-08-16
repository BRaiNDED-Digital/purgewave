import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, basename, extname } from 'node:path'
import { readTrack } from '../library/readTrack'

interface CollisionResolution {
  path: string
  /** true when the file already at the destination is a byte-identical copy — the move already happened. */
  alreadyThere: boolean
}

async function resolveCollisionFreeDestination(
  dest: string,
  sourceFp: string,
  artDir: string
): Promise<CollisionResolution> {
  let candidate = dest
  let n = 2
  for (;;) {
    try {
      await stat(candidate)
    } catch {
      return { path: candidate, alreadyThere: false } // nothing there — no collision
    }

    try {
      const { track } = await readTrack(candidate, artDir)
      if (track.fp === sourceFp) return { path: candidate, alreadyThere: true }
    } catch {
      // existing file unreadable; fall through to picking a new name
    }

    const ext = extname(dest)
    const base = basename(dest, ext)
    candidate = join(dirname(dest), `${base} (${n})${ext}`)
    n++
  }
}

/**
 * Moves one file into the quarantine folder, mirroring the library's directory structure
 * beneath it (spec §6.7). Same-volume uses `fs.rename` (instant); cross-volume falls back to
 * copy + size-verify + delete-source on `EXDEV`, and the source is never removed before the
 * copy is verified. Collisions are resolved by fingerprint: an identical file already at the
 * destination means the move already happened (source is just removed); a different file gets
 * `(2)`, `(3)`, ... appended.
 */
export async function moveFileToQuarantine(
  sourcePath: string,
  libraryRoot: string,
  quarantineRoot: string,
  sourceFp: string,
  artDir: string
): Promise<{ destPath: string }> {
  const relPath = relative(libraryRoot, sourcePath)
  const rawDest = join(quarantineRoot, relPath)
  await mkdir(dirname(rawDest), { recursive: true })

  const { path: destPath, alreadyThere } = await resolveCollisionFreeDestination(rawDest, sourceFp, artDir)

  if (alreadyThere) {
    await unlink(sourcePath)
    return { destPath }
  }

  try {
    await rename(sourcePath, destPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    const sourceStats = await stat(sourcePath)
    await copyFile(sourcePath, destPath)
    const destStats = await stat(destPath)
    if (destStats.size !== sourceStats.size) {
      throw new Error(`size mismatch after cross-volume copy of ${sourcePath}`)
    }
    await unlink(sourcePath)
  }

  return { destPath }
}
