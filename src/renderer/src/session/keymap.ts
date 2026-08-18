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
 * key must mark exactly one card. The two interaction methods for a decision are dragging the
 * card and A/D (mnemonic: A = purge/left, D = keep/right, mirroring the drag directions) — mouse
 * click used to also decide, but that was removed after real accidental-click reports; `Delete`/
 * `Enter` remain as secondary keyboard equivalents.
 */
export function resolveKeyIntent(e: KeyboardEvent): Intent | null {
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) return 'undo'

  switch (e.key) {
    case 'Delete':
    case 'a':
    case 'A':
      return 'discard'
    case 'Enter':
    case 'd':
    case 'D':
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
