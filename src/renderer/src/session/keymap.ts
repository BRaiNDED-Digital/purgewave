export type Intent =
  | 'discard'
  | 'keep'
  | 'playPause'
  | 'replay'
  | 'undo'
  | 'endSession'
  | 'volumeUp'
  | 'volumeDown'
  | 'help'

/**
 * Full §6.4 keyboard mapping. `event.repeat` is checked by the caller before this resolves —
 * holding a key must mark exactly one card. Play/pause, replay, and volume are recognized here
 * so the dispatch plumbing is in place, but have nothing to act on until M5 adds audio.
 */
export function resolveKeyIntent(e: KeyboardEvent): Intent | null {
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) return 'undo'

  switch (e.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
    case 'Delete':
      return 'discard'
    case 'ArrowRight':
    case 'd':
    case 'D':
    case 'Enter':
      return 'keep'
    case ' ':
      return 'playPause'
    case 'ArrowUp':
    case 'r':
    case 'R':
      return 'replay'
    case 'Backspace':
    case 'u':
    case 'U':
      return 'undo'
    case 'Escape':
      return 'endSession'
    case '+':
    case '=':
      return 'volumeUp'
    case '-':
      return 'volumeDown'
    case '?':
      return 'help'
    default:
      return null
  }
}

/** Mouse button 4 (back) also triggers undo. */
export function isUndoMouseButton(e: MouseEvent): boolean {
  return e.button === 3
}
