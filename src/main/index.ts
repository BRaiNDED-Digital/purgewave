import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import { join } from 'node:path'
import { scanLibrary } from './library/scan'
import { buildQueue } from './library/queue'
import { buildCard } from './library/cards'
import { resolveArtDataUrl } from './library/artwork'
import { registerTrackProtocolHandler } from './protocol/trackProtocol'
import { disposeTracks } from './disposal/dispose'
import { restoreMovedFile } from './disposal/restore'
import { computeLifetimeStats } from './library/stats'
import { findDormantTracks } from './library/dormant'
import { initAutoUpdater } from './updater'
import { writeJsonAtomic, readJsonWithFallback } from './state/atomicWrite'
import { DecisionsStore } from './state/decisionsStore'
import { getLibraryFilePath, getDecisionsFilePath, getArtDir, getSettingsFilePath } from './state/paths'
import type {
  LibraryFile,
  DecisionsFile,
  DecisionEntry,
  DisposalMode,
  DisposeResult,
  DormantTrack,
  LifetimeStats,
  MarkedTrack,
  ReviewLists,
  ScanIpcResult,
  ChooseRootResult,
  ChooseRootCancelled,
  Settings,
  SessionLimit,
  Card,
  TrackDecision
} from '../shared/types'
import { createEmptyDecisionsFile, createDefaultSettings } from '../shared/types'

// Must run before app is ready. `stream: true` lets the handler return a streamed Response;
// `supportFetchAPI` is what lets an <audio> element's Range requests reach our handler at all;
// `corsEnabled: true` is required for the dev server (renderer runs on the http://localhost:5173
// origin under Vite) to be allowed to load cross-origin track:// media at all.
protocol.registerSchemesAsPrivileged([
  { scheme: 'track', privileges: { stream: true, supportFetchAPI: true, corsEnabled: true, standard: true } }
])

let library: LibraryFile | null = null
let decisionsStore: DecisionsStore = new DecisionsStore(createEmptyDecisionsFile())
let settings: Settings = createDefaultSettings()

function toMarkedTrack(id: string): MarkedTrack | null {
  const track = library?.tracks[id]
  if (!track) return null
  return { id, title: track.title, artist: track.artist, path: track.path, size: track.size }
}

// Mirrors styles.css's --surface-base — the app is dark-only now, so this is just a constant.
// Kept in sync by hand: reading the CSS custom property from the main process isn't possible
// before a window/renderer exists, which is exactly the launch-time window this exists to close.
const BACKGROUND_COLOR = '#16151a'

// index.html's own <meta http-equiv="Content-Security-Policy"> covers the common case, but a
// meta tag can't express every directive (frame-ancestors and sandbox are HTTP-header-only) and
// Electron's own security checklist recommends setting CSP at the response-header level rather
// than relying on the meta tag alone. X-Content-Type-Options/X-Frame-Options/Referrer-Policy are
// the standard low-cost companions: nosniff matters most for the track:// handler (it does set a
// real Content-Type per file extension, but nothing stops a renderer bug from treating an
// unexpected response as something to sniff); the other two are cheap insurance even though this
// app has no iframe/cross-origin-referrer surface to actually exploit today.
//
// Deliberately skipped in dev mode (ELECTRON_RENDERER_URL set): intercepting the Vite dev
// server's own responses here broke its react-refresh preamble injection outright — the window
// loaded fully blank with "Uncaught Error: @vitejs/plugin-react can't detect preamble" in the
// console, confirmed by toggling this function on/off with everything else held constant, not
// just suspected from reading CSP semantics. Not worth chasing *why* dev-server response headers
// and Vite's HTML transform interact badly here: the dev server's responses never ship to a real
// user, only the packaged app's file:// document and track:// audio responses do, and both of
// those still go through this handler.
function registerSecurityHeaders(): void {
  if (process.env.ELECTRON_RENDERER_URL) return

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' track:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'Referrer-Policy': ['no-referrer']
      }
    })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 900,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    // §9.1 "no flash on launch": set before first paint so there's no white blink on a
    // dark-theme start, rather than showing a default-white window and repainting after.
    backgroundColor: BACKGROUND_COLOR,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Safe to enable: the preload script (src/preload/index.ts) only ever calls
      // contextBridge/ipcRenderer — no fs, no other Node built-ins — so it needs nothing sandbox
      // mode would take away.
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // This app never links out or opens external windows — any navigation away from the app's own
  // renderer document, or any attempt to open a new window/tab, can only be a malicious/compromised
  // renderer trying to reach an attacker-controlled page. Block both outright rather than trying to
  // allow-list destinations.
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    win.loadURL(rendererUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('library:chooseRoot', async (): Promise<ChooseRootResult | ChooseRootCancelled> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      properties: ['openDirectory']
    })
    if (canceled || filePaths.length === 0) return { cancelled: true }
    return { path: filePaths[0] }
  })

  ipcMain.handle('library:scan', async (event, { root }: { root: string }): Promise<ScanIpcResult> => {
    const outcome = await scanLibrary(root, library, decisionsStore.getAll(), {
      artDir: getArtDir(),
      quarantineFolder: settings.quarantineFolder,
      onProgress: (progress) => {
        event.sender.send('library:scanProgress', progress)
      }
    })

    if (outcome.aborted) return { aborted: true, reason: outcome.reason }

    library = outcome.library
    decisionsStore.replace(outcome.decisions)
    await writeJsonAtomic(getLibraryFilePath(), library)
    await writeJsonAtomic(getDecisionsFilePath(), outcome.decisions)
    return outcome.result
  })

  ipcMain.handle('library:getState', async () => {
    if (!library) {
      library = await readJsonWithFallback<LibraryFile>(getLibraryFilePath())
    }
    const decisions = decisionsStore.getAll().d
    const pendingDeletes = Object.values(decisions).filter((e) => e.s === 'delete').length
    // Same reasoning as reconcile.ts's ScanResult.total: exclude tracks marked `missing` (left
    // over from a previously-mapped root) so this reflects tracks actually under the current one.
    const trackCount = library ? Object.keys(library.tracks).filter((id) => decisions[id]?.s !== 'missing').length : 0
    return {
      root: library?.musicRoot ?? null,
      lastScanAt: library?.lastScanAt ?? null,
      trackCount,
      pendingDeletes
    }
  })

  ipcMain.handle('settings:chooseQuarantineFolder', async (): Promise<ChooseRootResult | ChooseRootCancelled> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
    if (canceled || filePaths.length === 0) return { cancelled: true }
    return { path: filePaths[0] }
  })

  ipcMain.handle('session:start', (_event, { limit }: { limit: SessionLimit }): string[] => {
    if (!library) return []
    const ids = buildQueue(library.tracks, decisionsStore.getAll().d)
    return limit ? ids.slice(0, limit) : ids
  })

  ipcMain.handle('session:getCards', async (_event, { trackIds }: { trackIds: string[] }): Promise<Card[]> => {
    if (!library) return []
    const cards: Card[] = []
    for (const id of trackIds) {
      const track = library.tracks[id]
      if (!track) continue
      const card = buildCard(id, library.tracks, library.folders, decisionsStore.getAll().d)
      card.artDataUrl = await resolveArtDataUrl(track.artPath)
      cards.push(card)
    }
    return cards
  })

  ipcMain.handle(
    'track:decide',
    (_event, { trackId, decision }: { trackId: string; decision: TrackDecision }): { ok: true } => {
      const existing = decisionsStore.get(trackId)
      const entry: DecisionEntry = { s: decision, r: Date.now(), n: (existing?.n ?? 0) + 1 }
      decisionsStore.set(trackId, entry)
      decisionsStore.recordDecision()
      return { ok: true }
    }
  )

  ipcMain.handle(
    'track:undo',
    (_event, { trackId, previous }: { trackId: string; previous: DecisionEntry | null }): { ok: true } => {
      decisionsStore.set(trackId, previous ?? undefined)
      decisionsStore.recordUndo()
      return { ok: true }
    }
  )

  ipcMain.handle('session:complete', (): { ok: true } => {
    decisionsStore.recordSessionCompleted()
    void decisionsStore.flush() // force-flush per §3.3: session end is one of the triggers
    return { ok: true }
  })

  ipcMain.handle(
    'track:gain',
    async (_event, { trackId, replayGainDb }: { trackId: string; replayGainDb: number }): Promise<{ ok: boolean }> => {
      if (!library?.tracks[trackId]) return { ok: false }
      library.tracks[trackId].replayGainDb = replayGainDb
      await writeJsonAtomic(getLibraryFilePath(), library)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'review:getMarked',
    (_event, { sessionKeptIds = [] }: { sessionKeptIds?: string[] } = {}): ReviewLists => {
      const d = decisionsStore.getAll().d
      const deleteIds = Object.entries(d)
        .filter(([, entry]) => entry.s === 'delete')
        .map(([id]) => id)

      const keep = sessionKeptIds.map(toMarkedTrack).filter((t): t is MarkedTrack => t !== null)
      const del = deleteIds.map(toMarkedTrack).filter((t): t is MarkedTrack => t !== null)
      const deleteBytes = del.reduce((sum, t) => sum + t.size, 0)

      return { keep, delete: del, deleteBytes }
    }
  )

  ipcMain.handle(
    'review:confirmDispose',
    async (_event, { trackIds, mode }: { trackIds: string[]; mode: DisposalMode }): Promise<DisposeResult> => {
      if (!library) {
        return {
          mode,
          disposed: 0,
          sidecarsDisposed: 0,
          foldersRemoved: 0,
          bytesReclaimed: 0,
          bytesMoved: 0,
          needsPermanentPrompt: [],
          failed: []
        }
      }
      const result = await disposeTracks(trackIds, mode, {
        library,
        decisionsStore,
        quarantineFolder: settings.quarantineFolder,
        artDir: getArtDir(),
        removeSidecarFiles: settings.removeSidecarFiles,
        removeEmptyFolders: settings.removeEmptyFolders
      })
      await writeJsonAtomic(getLibraryFilePath(), library)
      await decisionsStore.flush() // force-flush per §3.3: deletion confirm is one of the triggers
      return result
    }
  )

  ipcMain.handle(
    'review:confirmPermanent',
    async (_event, { trackIds }: { trackIds: string[] }): Promise<DisposeResult> => {
      if (!library) {
        return {
          mode: 'permanent',
          disposed: 0,
          sidecarsDisposed: 0,
          foldersRemoved: 0,
          bytesReclaimed: 0,
          bytesMoved: 0,
          needsPermanentPrompt: [],
          failed: []
        }
      }
      const result = await disposeTracks(trackIds, 'permanent', {
        library,
        decisionsStore,
        quarantineFolder: settings.quarantineFolder,
        artDir: getArtDir(),
        removeSidecarFiles: settings.removeSidecarFiles,
        removeEmptyFolders: settings.removeEmptyFolders
      })
      await writeJsonAtomic(getLibraryFilePath(), library)
      await decisionsStore.flush()
      return result
    }
  )

  ipcMain.handle('restore:list', (): MarkedTrack[] => {
    const d = decisionsStore.getAll().d
    return Object.keys(d)
      .filter((id) => d[id].s === 'moved')
      .map(toMarkedTrack)
      .filter((t): t is MarkedTrack => t !== null)
  })

  ipcMain.handle(
    'restore:run',
    async (
      _event,
      { trackIds }: { trackIds: string[] }
    ): Promise<{ restored: number; failed: { path: string; reason: string }[] }> => {
      if (!library) return { restored: 0, failed: [] }
      let restored = 0
      const failed: { path: string; reason: string }[] = []

      for (const id of trackIds) {
        const track = library.tracks[id]
        const entry = decisionsStore.get(id)
        if (!track || !entry || entry.s !== 'moved' || !entry.movedTo) continue

        const outcome = await restoreMovedFile(entry.movedTo, track.path)
        if (!outcome.ok) {
          failed.push({ path: track.path, reason: outcome.reason ?? 'unknown error' })
          continue
        }
        const { movedTo: _movedTo, x: _x, ...rest } = entry
        decisionsStore.set(id, { ...rest, s: 'keep' })
        restored++
      }

      await decisionsStore.flush()
      return { restored, failed }
    }
  )

  ipcMain.handle('stats:get', (): LifetimeStats => computeLifetimeStats(library, decisionsStore.getAll()))

  ipcMain.handle('library:previewForgetDormant', (): DormantTrack[] => {
    if (!library) return []
    return findDormantTracks(library, decisionsStore.getAll())
  })

  ipcMain.handle(
    'library:forgetDormant',
    async (_event, { trackIds }: { trackIds: string[] }): Promise<{ ok: true; forgotten: number }> => {
      if (!library) return { ok: true, forgotten: 0 }
      let forgotten = 0
      for (const id of trackIds) {
        const entry = decisionsStore.get(id)
        if (entry?.s !== 'missing') continue // never touch anything but missing records
        decisionsStore.set(id, undefined)
        delete library.tracks[id]
        forgotten++
      }
      await writeJsonAtomic(getLibraryFilePath(), library)
      await decisionsStore.flush()
      return { ok: true, forgotten }
    }
  )

  ipcMain.handle('settings:get', (): Settings => settings)

  ipcMain.handle('settings:update', async (_event, partial: Partial<Settings>): Promise<{ ok: true }> => {
    settings = { ...settings, ...partial }
    await writeJsonAtomic(getSettingsFilePath(), settings)
    return { ok: true }
  })
}

app.whenReady().then(async () => {
  library = await readJsonWithFallback<LibraryFile>(getLibraryFilePath())
  const loadedDecisions = await readJsonWithFallback<DecisionsFile>(getDecisionsFilePath())
  decisionsStore = new DecisionsStore(loadedDecisions ?? createEmptyDecisionsFile())
  // Merge over defaults, not replace: an older settings.json missing fields the schema has
  // since grown (exactly what happened going from M6 to M7) must not leave new fields as
  // `undefined` — every checkbox reading them would silently render unchecked regardless of
  // its real default. Caught by actually restarting against a pre-M7 settings.json, not by
  // inspection.
  settings = { ...createDefaultSettings(), ...(await readJsonWithFallback<Settings>(getSettingsFilePath())) }
  registerIpcHandlers()
  registerTrackProtocolHandler(() => library)
  registerSecurityHeaders()
  createWindow()
  if (settings.checkForUpdates) initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  decisionsStore.flush().finally(() => app.exit())
})
