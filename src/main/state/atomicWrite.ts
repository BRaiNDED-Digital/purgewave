import { rename, open, access, copyFile, readFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

// Two overlapping writers to the *same* path (e.g. several settings:update calls fired in the
// same render tick, unawaited from the renderer) would otherwise both open/write the shared
// `<name>.json.tmp` and race on the final rename — the loser's rename target no longer exists,
// throwing ENOENT. Chaining every write to a given path through one promise per path serializes
// them without callers needing to coordinate; found by real end-to-end testing (a genuine
// `ENOENT` on `settings.json.tmp` during rapid settings changes), not by inspection.
const writeChains = new Map<string, Promise<void>>()

/**
 * Atomic write per spec §3.3: serialize to <name>.json.tmp, fsync, rename over the target
 * (atomic on NTFS), and rotate the previous version to <name>.json.bak on each successful write.
 * Safe to call concurrently for the same path — writes to one path are serialized in call order.
 */
export function writeJsonAtomic(targetPath: string, data: unknown): Promise<void> {
  const previous = writeChains.get(targetPath) ?? Promise.resolve()
  const next = previous.then(() => writeJsonAtomicOnce(targetPath, data))
  // Swallow rejections in the chain itself (each caller still sees its own promise reject) so
  // one failed write doesn't permanently wedge every later write to the same path.
  writeChains.set(
    targetPath,
    next.catch(() => {})
  )
  return next
}

async function writeJsonAtomicOnce(targetPath: string, data: unknown): Promise<void> {
  const tmpPath = `${targetPath}.tmp`
  const bakPath = `${targetPath}.bak`
  const json = JSON.stringify(data, null, 2)

  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(json)
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await access(targetPath)
    await copyFile(targetPath, bakPath)
  } catch {
    // no existing file to back up yet
  }

  await rename(tmpPath, targetPath)
}

/**
 * Load JSON with the §3.3 fallback chain: primary, then .bak with a warning, then give up
 * without touching the corrupt file — the caller starts fresh but the original is preserved
 * for inspection rather than overwritten.
 */
export async function readJsonWithFallback<T>(targetPath: string): Promise<T | null> {
  const bakPath = `${targetPath}.bak`

  const tryParse = async (path: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as T
    } catch {
      return null
    }
  }

  const primary = await tryParse(targetPath)
  if (primary !== null) return primary

  let hadPrimary = false
  try {
    await access(targetPath)
    hadPrimary = true
  } catch {
    hadPrimary = false
  }

  const fromBak = await tryParse(bakPath)
  if (fromBak !== null) {
    if (hadPrimary) console.warn(`[state] ${targetPath} failed to parse; recovered from .bak`)
    return fromBak
  }

  if (hadPrimary) {
    const corruptPath = join(dirname(targetPath), `${basename(targetPath, '.json')}.corrupt-${Date.now()}.json`)
    try {
      await rename(targetPath, corruptPath)
      console.warn(
        `[state] ${targetPath} and its .bak both failed to parse; preserved as ${corruptPath} and starting fresh`
      )
    } catch {
      // best effort; do not throw for a diagnostics-only rename
    }
  }

  return null
}
