import { contextBridge, ipcRenderer } from 'electron'
import type {
  Card,
  ChooseRootCancelled,
  ChooseRootResult,
  DecisionEntry,
  DisposalMode,
  DisposeResult,
  DormantTrack,
  LifetimeStats,
  MarkedTrack,
  ReviewLists,
  ScanIpcResult,
  ScanProgress,
  SessionLimit,
  Settings,
  TrackDecision
} from '../shared/types'

const api = {
  chooseRoot: (): Promise<ChooseRootResult | ChooseRootCancelled> =>
    ipcRenderer.invoke('library:chooseRoot'),

  scan: (root: string): Promise<ScanIpcResult> => ipcRenderer.invoke('library:scan', { root }),

  onScanProgress: (callback: (progress: ScanProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress): void =>
      callback(progress)
    ipcRenderer.on('library:scanProgress', listener)
    return () => ipcRenderer.removeListener('library:scanProgress', listener)
  },

  getState: (): Promise<{
    root: string | null
    lastScanAt: string | null
    trackCount: number
    pendingDeletes: number
  }> => ipcRenderer.invoke('library:getState'),

  sessionStart: (limit: SessionLimit): Promise<string[]> => ipcRenderer.invoke('session:start', { limit }),

  sessionComplete: (): void => {
    void ipcRenderer.invoke('session:complete')
  },

  getCards: (trackIds: string[]): Promise<Card[]> => ipcRenderer.invoke('session:getCards', { trackIds }),

  // Fire-and-forget by design (spec §3.7 rule 1): never await this in the swipe/exit path.
  decide: (trackId: string, decision: TrackDecision): void => {
    void ipcRenderer.invoke('track:decide', { trackId, decision })
  },

  undo: (trackId: string, previous: DecisionEntry | null): void => {
    void ipcRenderer.invoke('track:undo', { trackId, previous })
  },

  cacheGain: (trackId: string, replayGainDb: number): void => {
    void ipcRenderer.invoke('track:gain', { trackId, replayGainDb })
  },

  trackUrl: (trackId: string): string => `track://${trackId}`,

  getMarked: (sessionKeptIds: string[]): Promise<ReviewLists> =>
    ipcRenderer.invoke('review:getMarked', { sessionKeptIds }),

  confirmDispose: (trackIds: string[], mode: DisposalMode): Promise<DisposeResult> =>
    ipcRenderer.invoke('review:confirmDispose', { trackIds, mode }),

  confirmPermanent: (trackIds: string[]): Promise<DisposeResult> =>
    ipcRenderer.invoke('review:confirmPermanent', { trackIds }),

  restoreList: (): Promise<MarkedTrack[]> => ipcRenderer.invoke('restore:list'),

  restoreRun: (trackIds: string[]): Promise<{ restored: number; failed: { path: string; reason: string }[] }> =>
    ipcRenderer.invoke('restore:run', { trackIds }),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),

  updateSettings: (partial: Partial<Settings>): Promise<{ ok: true }> =>
    ipcRenderer.invoke('settings:update', partial),

  chooseQuarantineFolder: (): Promise<ChooseRootResult | ChooseRootCancelled> =>
    ipcRenderer.invoke('settings:chooseQuarantineFolder'),

  getStats: (): Promise<LifetimeStats> => ipcRenderer.invoke('stats:get'),

  previewForgetDormant: (): Promise<DormantTrack[]> => ipcRenderer.invoke('library:previewForgetDormant'),

  forgetDormant: (trackIds: string[]): Promise<{ ok: true; forgotten: number }> =>
    ipcRenderer.invoke('library:forgetDormant', { trackIds }),

  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),

  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),

  onUpdateAvailable: (callback: (info: { version: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string }): void => callback(info)
    ipcRenderer.on('updater:available', listener)
    return () => ipcRenderer.removeListener('updater:available', listener)
  },

  onUpdateDownloaded: (callback: (info: { version: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string }): void => callback(info)
    ipcRenderer.on('updater:downloaded', listener)
    return () => ipcRenderer.removeListener('updater:downloaded', listener)
  },

  onUpdateProgress: (callback: (info: { percent: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { percent: number }): void => callback(info)
    ipcRenderer.on('updater:progress', listener)
    return () => ipcRenderer.removeListener('updater:progress', listener)
  }
}

contextBridge.exposeInMainWorld('purgewave', api)

export type PurgeWaveApi = typeof api
