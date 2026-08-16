const SUPPORTED_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.aiff',
  '.alac'
])

export function isSupportedAudioFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return SUPPORTED_EXTENSIONS.has(path.slice(dot).toLowerCase())
}
