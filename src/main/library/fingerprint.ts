import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

const CHUNK_SIZE = 64 * 1024

/**
 * fp = sha1(64KB read from the middle of the file || size || round(durationSec)), truncated to 16 hex chars.
 * Read from the middle, never the start: ID3v2 tags sit at the front, so a head-based hash
 * would change every time the user edits a tag and would defeat the point of a content identity.
 */
export async function computeFingerprint(
  path: string,
  size: number,
  durationSec: number
): Promise<string> {
  const offset = Math.floor(size / 2)
  const length = Math.max(Math.min(CHUNK_SIZE, size - offset), 0)
  const buf = Buffer.alloc(length)

  if (length > 0) {
    const handle = await open(path, 'r')
    try {
      await handle.read(buf, 0, length, offset)
    } finally {
      await handle.close()
    }
  }

  const hash = createHash('sha1')
  hash.update(buf)
  hash.update(String(size))
  hash.update(String(Math.round(durationSec)))
  return hash.digest('hex').slice(0, 16)
}
