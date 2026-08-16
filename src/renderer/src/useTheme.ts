import { useEffect } from 'react'
import type { Theme } from '../../shared/types'

/**
 * Applies §9.1's `data-theme` attribute on the root element. 'system' tracks
 * prefers-color-scheme live rather than snapshotting it once. The "no flash on launch" half of
 * §9.1 (reading the preference before the window is shown, setting BrowserWindow's
 * backgroundColor to match) is a main-process concern — that's M8's job, not this hook's.
 */
export function useTheme(theme: Theme): void {
  useEffect(() => {
    const root = document.documentElement

    if (theme !== 'system') {
      root.dataset.theme = theme
      return
    }

    delete root.dataset.theme
    // No explicit dataset.theme needed for 'system' — styles.css's prefers-color-scheme media
    // query already handles it as long as nothing else stamped a value; nothing to clean up.
  }, [theme])
}
