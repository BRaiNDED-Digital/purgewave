import { stat, mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { walkAudioFiles } from './walk'
import { readTrack } from './readTrack'
import { resolveFolderArt } from './artwork'
import { reconcile, type FreshFileEntry } from './reconcile'
import type { DecisionsFile, LibraryFile, ScanProgress, ScanResult } from '../../shared/types'

const CONCURRENCY = 4
const PROGRESS_INTERVAL = 250

export interface ScanDeps {
  artDir: string
  onProgress: (progress: ScanProgress) => void
  /** Always excluded from the walk, even when nested inside the library root (spec §3.5/§6.7). */
  quarantineFolder?: string | null
}

export interface ScanSuccess {
  aborted: false
  library: LibraryFile
  decisions: DecisionsFile
  result: ScanResult
}

export interface ScanAborted {
  aborted: true
  reason: 'unreadable-root' | 'empty-scan'
}

export type ScanOutcome = ScanSuccess | ScanAborted

async function isReadableDirectory(root: string): Promise<boolean> {
  try {
    const stats = await stat(root)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Walks `root`, reconciles it against whatever was previously indexed, and returns the merged
 * result — never writes anything itself, so a first-ever scan and a rescan of an existing
 * library are the same code path (`previousLibrary: null` degenerates to "everything is new").
 */
export async function scanLibrary(
  root: string,
  previousLibrary: LibraryFile | null,
  previousDecisions: DecisionsFile,
  deps: ScanDeps
): Promise<ScanOutcome> {
  if (!(await isReadableDirectory(root))) {
    return { aborted: true, reason: 'unreadable-root' }
  }

  await mkdir(deps.artDir, { recursive: true })

  const excludeDirs = new Set<string>()
  if (deps.quarantineFolder) excludeDirs.add(deps.quarantineFolder)
  const paths = await walkAudioFiles(root, excludeDirs)
  const total = paths.length

  const prevByPath = new Map<string, LibraryFile['tracks'][string]>()
  if (previousLibrary) {
    for (const track of Object.values(previousLibrary.tracks)) prevByPath.set(track.path, track)
  }

  const freshEntries: FreshFileEntry[] = []
  let scanned = 0

  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < paths.length) {
      const index = cursor++
      const path = paths[index]

      try {
        const prev = prevByPath.get(path)
        const stats = await stat(path)

        if (prev && prev.size === stats.size && prev.mtimeMs === stats.mtimeMs) {
          // Unchanged since the last scan: reuse tags/fingerprint/art rather than re-reading
          // the file, per §3.8 — this is what keeps a rescan of a stable tree down to seconds.
          freshEntries.push({ ...prev, birthtimeMs: stats.birthtimeMs })
        } else {
          const { track } = await readTrack(path, deps.artDir)
          freshEntries.push(track)
        }
      } catch {
        // A single unreadable file must not abort the whole scan.
      }

      scanned++
      if (scanned % PROGRESS_INTERVAL === 0 || scanned === total) {
        deps.onProgress({ scanned, total, currentPath: path })
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, paths.length) || 1
  await Promise.all(Array.from({ length: workerCount }, worker))

  const scanSeq = (previousLibrary?.scanSeq ?? 0) + 1
  const outcome = reconcile({
    musicRoot: root,
    previousLibrary,
    previousDecisions,
    freshEntries,
    scanSeq
  })

  if (outcome.aborted) return outcome

  for (const folder of Object.keys(outcome.library.folders)) {
    const artPath = await resolveFolderArt(folder)
    outcome.library.folders[folder].art = artPath ? basename(artPath) : null
  }

  return { aborted: false, library: outcome.library, decisions: outcome.decisions, result: outcome.result }
}
