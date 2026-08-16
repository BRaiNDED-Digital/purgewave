import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic, readJsonWithFallback } from './atomicWrite'

describe('writeJsonAtomic', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pw-atomicwrite-'))
    target = join(dir, 'settings.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('serializes overlapping concurrent writes to the same path instead of racing', async () => {
    // Regression test: several unawaited writes fired in the same tick (as settings:update did
    // from SwipeScreen's separate autoplay/normalize/volume sync effects) used to race on the
    // shared <name>.json.tmp file and throw ENOENT on rename. None of these are awaited before
    // the next starts, mirroring the real bug's shape.
    const writes = Promise.all([
      writeJsonAtomic(target, { n: 1 }),
      writeJsonAtomic(target, { n: 2 }),
      writeJsonAtomic(target, { n: 3 }),
      writeJsonAtomic(target, { n: 4 }),
      writeJsonAtomic(target, { n: 5 })
    ])

    await expect(writes).resolves.toBeDefined()

    const final = JSON.parse(await readFile(target, 'utf-8'))
    expect(final.n).toBe(5) // last call in submission order wins, deterministically

    const loaded = await readJsonWithFallback<{ n: number }>(target)
    expect(loaded).toEqual({ n: 5 })
  })

  it('keeps writes to different paths independent', async () => {
    const targetB = join(dir, 'other.json')
    await Promise.all([writeJsonAtomic(target, { a: true }), writeJsonAtomic(targetB, { b: true })])

    expect(await readJsonWithFallback(target)).toEqual({ a: true })
    expect(await readJsonWithFallback(targetB)).toEqual({ b: true })
  })
})
