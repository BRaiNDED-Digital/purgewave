import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSameBasenameSidecars, findAlbumArtIfLastTrack } from './sidecars'

describe('sidecars', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pw-sidecars-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds same-basename companions but not the track itself or unrelated files', async () => {
    const track = join(dir, '03 Track.mp3')
    await writeFile(track, '')
    await writeFile(join(dir, '03 Track.lrc'), '')
    await writeFile(join(dir, '03 Track.jpg'), '')
    await writeFile(join(dir, '04 Other Track.txt'), '')
    await mkdir(join(dir, 'subdir'))

    const found = await findSameBasenameSidecars(track)

    expect(found.sort()).toEqual([join(dir, '03 Track.jpg'), join(dir, '03 Track.lrc')].sort())
  })

  it('ignores extensions outside the sidecar set', async () => {
    const track = join(dir, 'track.mp3')
    await writeFile(track, '')
    await writeFile(join(dir, 'track.flac'), '') // a duplicate audio file, not a sidecar

    const found = await findSameBasenameSidecars(track)

    expect(found).toEqual([])
  })

  it('finds album art only when the track is the last remaining audio file', async () => {
    const track = join(dir, 'Album', '01 Track.mp3')
    await mkdir(join(dir, 'Album'))
    await writeFile(track, '')
    await writeFile(join(dir, 'Album', 'cover.jpg'), '')

    expect(await findAlbumArtIfLastTrack(track, 2)).toBeNull()
    expect(await findAlbumArtIfLastTrack(track, 0)).toBe(join(dir, 'Album', 'cover.jpg'))
  })

  it('returns null when there is no recognized album art filename', async () => {
    const track = join(dir, 'Album', '01 Track.mp3')
    await mkdir(join(dir, 'Album'))
    await writeFile(track, '')
    await writeFile(join(dir, 'Album', 'random-image.jpg'), '')

    expect(await findAlbumArtIfLastTrack(track, 0)).toBeNull()
  })
})
