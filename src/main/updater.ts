import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Check on launch, notify the renderer, and let the user decide when to download and restart —
 * per user request, replacing the original spec §11 "silent background download, install on
 * quit" behavior. That original flow shipped in v1.0.0/v1.0.1 but was never actually observed to
 * update a real install: most likely cause is a per-machine (Program Files) install requiring
 * admin elevation that a background update step can't get (see electron-builder.yml's new
 * `perMachine: false`), compounded by the old code having no 'error' listener at all — an
 * unhandled 'error' event on an EventEmitter throws, so a failed check/download could fail
 * completely silently with nothing surfaced anywhere. This version logs every lifecycle event to
 * a plain text file so a failure is diagnosable instead of invisible.
 */
function logPath(): string {
  return join(app.getPath('userData'), 'update.log')
}

async function log(line: string): Promise<void> {
  try {
    await appendFile(logPath(), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // Logging must never take down the update flow.
  }
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  autoUpdater.on('error', (err) => {
    void log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  })
  autoUpdater.on('checking-for-update', () => void log('checking-for-update'))
  autoUpdater.on('update-not-available', (info) => void log(`update-not-available (current ${info.version})`))
  autoUpdater.on('update-available', (info) => {
    void log(`update-available: ${info.version}`)
    send('updater:available', { version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    void log(`download-progress: ${Math.round(p.percent)}%`)
    send('updater:progress', { percent: p.percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    void log(`update-downloaded: ${info.version}`)
    send('updater:downloaded', { version: info.version })
  })

  void log(`initAutoUpdater: current version ${app.getVersion()}, checking for updates`)
  autoUpdater.checkForUpdates().catch((err) => void log(`checkForUpdates failed: ${err}`))
}

export async function downloadUpdate(): Promise<void> {
  await log('user requested download')
  await autoUpdater.downloadUpdate()
}

export function installUpdate(): void {
  void log('user requested install/restart')
  autoUpdater.quitAndInstall()
}
