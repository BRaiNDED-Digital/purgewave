import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isSupportedAudioFile } from './extensions'

export async function walkAudioFiles(root: string, excludeDirs: Set<string> = new Set()): Promise<string[]> {
  const results: string[] = []
  const stack: string[] = [root]

  while (stack.length > 0) {
    const dir = stack.pop() as string
    if (excludeDirs.has(dir)) continue

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && isSupportedAudioFile(full)) {
        results.push(full)
      }
    }
  }

  return results
}
