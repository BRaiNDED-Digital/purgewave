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
 * Keyboard mapping. `event.repeat` is checked by the caller before this resolves — holding a
 * key must mark exactly one card. Arrow keys and A/D are deliberately not mapped to discard/keep
 * — the two interaction methods for a decision are dragging the card and left/right mouse click
 * (see `SwipeCard`'s pointer handlers); `Delete`/`Enter` remain as keyboard equivalents.
 */
export function resolveKeyIntent(e: KeyboardEvent): Intent | null {
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) return 'undo'

  switch (e.key) {
    case 'Delete':
      return 'discard'
    case 'Enter':
      return 'keep'
    case ' ':
      return 'playPause'
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
