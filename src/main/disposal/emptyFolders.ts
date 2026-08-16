import { readdir, rm } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { shell } from 'electron'

const LEFTOVER_EXTS = new Set(['.m3u', '.nfo'])

async function isEmptyOrOnlyLeftovers(dir: string): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  if (entries.length === 0) return true
  return entries.every((e) => e.isFile() && LEFTOVER_EXTS.has(extname(e.name).toLowerCase()))
}

/**
 * After a disposal batch, walks upward from each affected directory removing folders that are
 * now empty (or contain only leftover .m3u/.nfo files), stopping at `musicRoot` — never removes
 * the root itself. Removed folders go to the Recycle Bin when that's the active disposal mode,
 * deleted outright otherwise, matching whatever just happened to the files inside them.
 */
export async function removeEmptyFoldersUpward(
  affectedDirs: Iterable<string>,
  musicRoot: string,
  useRecycleBin: boolean
): Promise<number> {
  const root = resolve(musicRoot)
  let removed = 0

  // No "visited" guard: a parent directory can legitimately become empty only after a *later*
  // sibling branch's removal (two albums under one artist, both emptied in the same batch), so
  // it must stay eligible to re-check. This can't loop forever or double-remove — each removed
  // directory is gone from disk, so `isEmptyOrOnlyLeftovers` on it next time just fails closed.
  for (const startDir of affectedDirs) {
    let dir = resolve(startDir)
    while (dir !== root && dir.startsWith(root)) {
      if (!(await isEmptyOrOnlyLeftovers(dir))) break
      try {
        if (useRecycleBin) await shell.trashItem(dir)
        else await rm(dir, { recursive: true })
        removed++
      } catch {
        break
      }
      dir = dirname(dir)
    }
  }

  return removed
}
