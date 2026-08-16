import { shell } from 'electron'
import { unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { findSameBasenameSidecars, findAlbumArtIfLastTrack } from './sidecars'
import { moveFileToQuarantine } from './quarantineMove'
import { removeEmptyFoldersUpward } from './emptyFolders'
import type { DecisionEntry, DisposalMode, DisposeResult, LibraryFile } from '../../shared/types'
import type { DecisionsStore } from '../state/decisionsStore'

export interface DisposeDeps {
  library: LibraryFile
  decisionsStore: DecisionsStore
  quarantineFolder: string | null
  artDir: string
  removeSidecarFiles: boolean
  removeEmptyFolders: boolean
}

function fallbackEntry(decisionsStore: DecisionsStore, id: string): DecisionEntry {
  return decisionsStore.get(id) ?? { s: 'delete', r: Date.now(), n: 1 }
}

/**
 * Disposes of a batch of already `delete`-marked tracks per spec §6.7. Three modes share one
 * code path here on purpose: the sidecar/empty-folder/decision-update logic is identical, only
 * the actual removal primitive (`shell.trashItem`, quarantine move, `fs.unlink`) differs.
 *
 * Recycle Bin mode stops the whole batch on the first failure (no Recycle Bin on this volume,
 * or a locked file) rather than silently falling back to permanent delete — the caller must ask
 * the user, and the untried remainder comes back in `needsPermanentPrompt`.
 */
export async function disposeTracks(
  trackIds: string[],
  mode: DisposalMode,
  deps: DisposeDeps
): Promise<DisposeResult> {
  const { library, decisionsStore, quarantineFolder, artDir, removeSidecarFiles, removeEmptyFolders } = deps
  const musicRoot = library.musicRoot

  const result: DisposeResult = {
    mode,
    disposed: 0,
    sidecarsDisposed: 0,
    foldersRemoved: 0,
    bytesReclaimed: 0,
    bytesMoved: 0,
    needsPermanentPrompt: [],
    failed: []
  }

  if (mode === 'quarantine' && (!quarantineFolder || !musicRoot)) {
    result.failed = trackIds.map((id) => ({
      path: library.tracks[id]?.path ?? id,
      reason: 'no quarantine folder configured'
    }))
    return result
  }

  const affectedDirs = new Set<string>()
  const batchSet = new Set(trackIds)
  let stopBatch = false

  for (const id of trackIds) {
    if (stopBatch) {
      result.needsPermanentPrompt.push(id)
      continue
    }

    const track = library.tracks[id]
    if (!track) continue

    const folder = library.folders[dirname(track.path)]
    const remainingSiblings = folder
      ? folder.ids.filter((sid) => {
          if (sid === id || batchSet.has(sid)) return false
          const d = decisionsStore.get(sid)
          return !(d && (d.s === 'trashed' || d.s === 'moved' || d.s === 'missing'))
        }).length
      : 0

    const sameBasenameSidecars = removeSidecarFiles ? await findSameBasenameSidecars(track.path) : []
    const albumArt = removeSidecarFiles ? await findAlbumArtIfLastTrack(track.path, remainingSiblings) : null

    try {
      if (mode === 'recycle-bin') {
        await shell.trashItem(track.path)
        result.bytesReclaimed += track.size
        result.disposed++
        decisionsStore.set(id, { ...fallbackEntry(decisionsStore, id), s: 'trashed', x: Date.now() })
        decisionsStore.recordDisposal('trashed', track.size)
        affectedDirs.add(dirname(track.path))

        for (const sidecar of sameBasenameSidecars) {
          try {
            await shell.trashItem(sidecar)
            result.sidecarsDisposed++
          } catch {
            /* sidecar loss is not batch-fatal */
          }
        }
        if (albumArt) {
          try {
            await shell.trashItem(albumArt)
            result.sidecarsDisposed++
          } catch {
            /* sidecar loss is not batch-fatal */
          }
        }
      } else if (mode === 'quarantine') {
        const { destPath } = await moveFileToQuarantine(track.path, musicRoot!, quarantineFolder!, track.fp, artDir)
        result.bytesMoved += track.size
        result.disposed++
        decisionsStore.set(id, { ...fallbackEntry(decisionsStore, id), s: 'moved', x: Date.now(), movedTo: destPath })
        decisionsStore.recordDisposal('moved', track.size)
        affectedDirs.add(dirname(track.path))

        for (const sidecar of sameBasenameSidecars) {
          try {
            await moveFileToQuarantine(sidecar, musicRoot!, quarantineFolder!, `sidecar:${sidecar}`, artDir)
            result.sidecarsDisposed++
          } catch {
            /* sidecar loss is not batch-fatal */
          }
        }
        if (albumArt) {
          try {
            await moveFileToQuarantine(albumArt, musicRoot!, quarantineFolder!, `art:${albumArt}`, artDir)
            result.sidecarsDisposed++
          } catch {
            /* sidecar loss is not batch-fatal */
          }
        }
      } else {
        await unlink(track.path)
        result.bytesReclaimed += track.size
        result.disposed++
        decisionsStore.set(id, { ...fallbackEntry(decisionsStore, id), s: 'trashed', x: Date.now() })
        decisionsStore.recordDisposal('trashed', track.size)
        affectedDirs.add(dirname(track.path))

        for (const sidecar of sameBasenameSidecars) {
          try {
            await unlink(sidecar)
            result.sidecarsDisposed++
          } catch {
            /* sidecar loss is not batch-fatal */
          }
        }
        if (albumArt) {
          try {
            await unlink(albumArt)
            result.sidecarsDisposed++
          } catch {
            /* sidecar loss is not batch-fatal */
          }
        }
      }
    } catch (err) {
      if (mode === 'recycle-bin') {
        stopBatch = true
        result.needsPermanentPrompt.push(id)
      } else {
        result.failed.push({ path: track.path, reason: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  result.foldersRemoved = removeEmptyFolders
    ? await removeEmptyFoldersUpward(affectedDirs, musicRoot ?? '', mode === 'recycle-bin')
    : 0

  return result
}
