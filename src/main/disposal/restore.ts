import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Puts one quarantined file back at its original path, recreating folders as needed (spec
 * §6.7). If something now occupies the original path, the caller must skip and report it — we
 * never overwrite.
 */
export async function restoreMovedFile(currentPath: string, originalPath: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await stat(originalPath)
    return { ok: false, reason: 'original path is occupied' }
  } catch {
    // good — nothing there
  }

  await mkdir(dirname(originalPath), { recursive: true })

  try {
    await rename(currentPath, originalPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    try {
      await copyFile(currentPath, originalPath)
      await unlink(currentPath)
    } catch (copyErr) {
      return { ok: false, reason: copyErr instanceof Error ? copyErr.message : String(copyErr) }
    }
  }

  return { ok: true }
}
