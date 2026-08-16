import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeEmptyFoldersUpward } from './emptyFolders'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('removeEmptyFoldersUpward', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pw-emptyfolders-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('removes an empty leaf folder, and stops at the library root', async () => {
    const leaf = join(root, 'Artist', 'Album')
    await mkdir(leaf, { recursive: true })

    const removed = await removeEmptyFoldersUpward([leaf], root, false)

    expect(removed).toBe(2) // Album, then Artist
    expect(await exists(leaf)).toBe(false)
    expect(await exists(join(root, 'Artist'))).toBe(false)
    expect(await exists(root)).toBe(true) // root itself is never removed
  })

  it('treats leftover .m3u/.nfo files as empty, but stops at a folder with real content', async () => {
    const leaf = join(root, 'Artist', 'Album')
    await mkdir(leaf, { recursive: true })
    await writeFile(join(leaf, 'playlist.m3u'), '')
    await writeFile(join(root, 'Artist', 'notes.nfo'), '')
    await writeFile(join(root, 'Artist', 'keep-me.mp3'), '') // real content stops the walk here

    const removed = await removeEmptyFoldersUpward([leaf], root, false)

    expect(removed).toBe(1) // only Album removed
    expect(await exists(leaf)).toBe(false)
    expect(await exists(join(root, 'Artist'))).toBe(true)
  })

  it('does not remove a folder that still has real files', async () => {
    const leaf = join(root, 'Artist', 'Album')
    await mkdir(leaf, { recursive: true })
    await writeFile(join(leaf, '02 Still Here.mp3'), '')

    const removed = await removeEmptyFoldersUpward([leaf], root, false)

    expect(removed).toBe(0)
    expect(await exists(leaf)).toBe(true)
  })

  it('does not visit the same folder twice across multiple affected dirs', async () => {
    const albumA = join(root, 'Artist', 'AlbumA')
    const albumB = join(root, 'Artist', 'AlbumB')
    await mkdir(albumA, { recursive: true })
    await mkdir(albumB, { recursive: true })

    const removed = await removeEmptyFoldersUpward([albumA, albumB], root, false)

    // AlbumA, AlbumB, and Artist (visited once even though reached from both branches)
    expect(removed).toBe(3)
    expect(await exists(join(root, 'Artist'))).toBe(false)
  })
})
