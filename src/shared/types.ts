export interface Track {
  path: string
  size: number
  mtimeMs: number
  birthtimeMs: number
  title: string
  artist: string
  album: string
  trackNo: number | null
  year: number | null
  durationSec: number
  bitrate: number | null
  format: string
  hasArtwork: boolean
  artPath: string | null
  replayGainDb: number | null
  fp: string
  lastSeenScan: number
  dupOf?: string
  previewUnsupported?: boolean
  titleIsFilenameFallback?: boolean
}

export interface FolderEntry {
  ids: string[]
  art: string | null
}

export interface LibraryFile {
  schemaVersion: 1
  musicRoot: string | null
  lastScanAt: string | null
  nextId: number
  scanSeq: number
  folders: Record<string, FolderEntry>
  tracks: Record<string, Track>
}

export interface ScanProgress {
  scanned: number
  total: number
  currentPath: string
}

export interface ScanResult {
  added: number
  updated: number
  missing: number
  pruned: number
  total: number
}

export interface ScanAbortedResult {
  aborted: true
  reason: 'unreadable-root' | 'empty-scan'
}

export type ScanIpcResult = ScanResult | ScanAbortedResult

export interface ChooseRootResult {
  path: string
  cancelled?: false
}

export interface ChooseRootCancelled {
  cancelled: true
}

export type DecisionStatus = 'keep' | 'delete' | 'trashed' | 'moved' | 'missing'

export interface DecisionEntry {
  s: DecisionStatus
  r: number // reviewedAt (ms epoch)
  n: number // reviewCount
  x?: number // trashedAt / movedAt
  movedTo?: string
  // The status held before this entry became 'missing', so a reappearing file restores
  // exactly what it was. 'unreviewed' means it had no decisions entry at all.
  was?: DecisionStatus | 'unreviewed'
}

export interface DecisionsStats {
  totalReviewed: number
  totalTrashed: number
  totalMoved: number
  bytesReclaimed: number
  bytesMoved: number
  sessionsCompleted: number
  firstReviewAt: string | null
}

export interface DecisionsFile {
  schemaVersion: 1
  d: Record<string, DecisionEntry>
  stats: DecisionsStats
}

export type SessionLimit = 10 | 25 | 50 | 100 | null

export interface AlbumContext {
  index: number
  total: number
  albumName: string
  markedForDeletion: number
}

export interface PastReview {
  lastReviewedAt: number
  reviewCount: number
}

export interface Card {
  id: string
  title: string
  titleIsFilenameFallback: boolean
  artist: string
  album: string
  year: number | null
  format: string
  bitrate: number | null
  size: number
  birthtimeMs: number
  durationSec: number
  artDataUrl: string | null
  previewUnsupported: boolean
  albumContext: AlbumContext | null
  pastReview: PastReview | null
  replayGainDb: number | null
}

export type TrackDecision = 'keep' | 'delete'

export type DisposalMode = 'recycle-bin' | 'quarantine' | 'permanent'

export type Theme = 'light' | 'dark' | 'system'

export interface Settings {
  schemaVersion: 1
  autoplay: boolean
  volume: number
  normalizeVolume: boolean
  disposalMode: DisposalMode
  quarantineFolder: string | null
  sideClickDecisions: boolean
  removeSidecarFiles: boolean
  removeEmptyFolders: boolean
  theme: Theme
  checkForUpdates: boolean
}

export function createDefaultSettings(): Settings {
  return {
    schemaVersion: 1,
    autoplay: true,
    volume: 0.8,
    normalizeVolume: true,
    disposalMode: 'recycle-bin',
    quarantineFolder: null,
    sideClickDecisions: true,
    removeSidecarFiles: true,
    removeEmptyFolders: true,
    theme: 'system',
    checkForUpdates: true
  }
}

export interface MarkedTrack {
  id: string
  title: string
  artist: string
  path: string
  size: number
}

export interface ReviewLists {
  keep: MarkedTrack[]
  delete: MarkedTrack[]
  deleteBytes: number
}

export interface DisposeFailure {
  path: string
  reason: string
}

export interface DisposeResult {
  mode: DisposalMode
  disposed: number
  sidecarsDisposed: number
  foldersRemoved: number
  bytesReclaimed: number
  bytesMoved: number
  needsPermanentPrompt: string[]
  failed: DisposeFailure[]
}

export interface WeeklyBucket {
  weekStartIso: string
  count: number
}

export interface LifetimeStats {
  totalReviewed: number
  totalKept: number
  totalPendingDelete: number
  totalDisposed: number
  keepRate: number
  bytesReclaimed: number
  bytesMoved: number
  libraryTotal: number
  libraryUnreviewed: number
  percentTriaged: number
  sessionsCompleted: number
  reviewingSinceAt: string | null
  weeklyReviewed: WeeklyBucket[]
}

export interface DormantTrack {
  id: string
  title: string
  artist: string
  path: string
  scansUnseen: number
}

export function createEmptyDecisionsFile(): DecisionsFile {
  return {
    schemaVersion: 1,
    d: {},
    stats: {
      totalReviewed: 0,
      totalTrashed: 0,
      totalMoved: 0,
      bytesReclaimed: 0,
      bytesMoved: 0,
      sessionsCompleted: 0,
      firstReviewAt: null
    }
  }
}
