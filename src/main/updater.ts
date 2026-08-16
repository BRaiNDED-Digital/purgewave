import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Spec §11: check on launch, download in the background, install on quit, never interrupt an
 * active session with a prompt. `autoInstallOnAppQuit` is electron-updater's default (true) —
 * once a download completes it installs itself on the next quit with no extra code here.
 *
 * Not exercised end-to-end anywhere in this codebase: it needs a real packaged build pointed at
 * a real GitHub Releases feed (electron-builder.yml's `publish.owner`/`repo` are placeholders),
 * neither of which exist yet. `autoUpdater` is also a no-op outside a packaged app, so this is
 * safe to call unconditionally in dev — it just does nothing.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) return

  try {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    void autoUpdater.checkForUpdates()
  } catch {
    // A failed update check must never take down the app.
  }
}
