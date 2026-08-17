import { useEffect, useState } from 'react'
import type { ScanProgress, ScanResult, SessionLimit, Theme } from '../../shared/types'
import { SessionLengthPicker } from './session/SessionLengthPicker'
import { SwipeScreen, type SessionSummary } from './session/SwipeScreen'
import { ReviewScreen } from './session/ReviewScreen'
import { RestoreScreen } from './session/RestoreScreen'
import { SettingsScreen } from './session/SettingsScreen'
import { StatsScreen } from './session/StatsScreen'
import { GearIcon, BarChartIcon } from './session/icons'
import { useTheme } from './useTheme'

type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning'; progress: ScanProgress | null }
  | { phase: 'done'; result: ScanResult }
  | { phase: 'aborted'; reason: 'unreadable-root' | 'empty-scan' }
  | { phase: 'error'; message: string }

type View =
  | { name: 'library' }
  | { name: 'resume'; pendingDeletes: number }
  | { name: 'sessionPicker' }
  | { name: 'swiping'; queue: string[]; limit: SessionLimit }
  | { name: 'review'; sessionKeptIds: string[] }
  | { name: 'restore' }
  | { name: 'settings' }
  | { name: 'stats' }

function App() {
  const [root, setRoot] = useState<string | null>(null)
  const [trackCount, setTrackCount] = useState(0)
  const [scan, setScan] = useState<ScanState>({ phase: 'idle' })
  const [view, setView] = useState<View>({ name: 'library' })
  const [resumeShown, setResumeShown] = useState(false)
  const [theme, setTheme] = useState<Theme>('system')
  const [startingSession, setStartingSession] = useState(false)
  const [pendingDeletes, setPendingDeletes] = useState(0)
  const [quarantineFolder, setQuarantineFolder] = useState<string | null>(null)
  const [quarantineCount, setQuarantineCount] = useState(0)

  useTheme(theme)

  useEffect(() => {
    window.purgewave.getSettings().then((s) => setTheme(s.theme))
  }, [])

  useEffect(() => {
    window.purgewave.getState().then((state) => {
      setRoot(state.root)
      setTrackCount(state.trackCount)
      setPendingDeletes(state.pendingDeletes)
      // Shown once per launch (§6.2), before anything else, only when marks actually survived.
      if (!resumeShown && state.pendingDeletes > 0) {
        setResumeShown(true)
        setView({ name: 'resume', pendingDeletes: state.pendingDeletes })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-derives the main menu's conditional actions ("Review marked", "View Quarantine") every
  // time the user lands back on it — a session, a review, or a settings change can all move
  // these counts, and the menu should never show a stale action that no longer applies.
  useEffect(() => {
    if (view.name !== 'library') return
    Promise.all([window.purgewave.getState(), window.purgewave.getSettings(), window.purgewave.restoreList()]).then(
      ([state, settings, quarantined]) => {
        setRoot(state.root)
        setTrackCount(state.trackCount)
        setPendingDeletes(state.pendingDeletes)
        setQuarantineFolder(settings.quarantineFolder)
        setQuarantineCount(quarantined.length)
      }
    )
  }, [view.name])

  useEffect(() => {
    return window.purgewave.onScanProgress((progress) => {
      setScan((prev) => (prev.phase === 'scanning' ? { phase: 'scanning', progress } : prev))
    })
  }, [])

  async function handleChooseFolder(): Promise<void> {
    const chosen = await window.purgewave.chooseRoot()
    if ('cancelled' in chosen) return
    await runScan(chosen.path)
  }

  async function runScan(scanRoot: string): Promise<void> {
    setScan({ phase: 'scanning', progress: null })
    try {
      const outcome = await window.purgewave.scan(scanRoot)
      if ('aborted' in outcome) {
        // Guard tripped (§3.5): state is left untouched, so the previously-confirmed root
        // (if any) stays displayed rather than the folder that just failed to scan.
        setScan({ phase: 'aborted', reason: outcome.reason })
        return
      }
      setRoot(scanRoot)
      setTrackCount(outcome.total)
      setScan({ phase: 'done', result: outcome })
    } catch (err) {
      setScan({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function startSession(limit: SessionLimit): Promise<void> {
    // Rescan right before building the queue, not just on an explicit "Change folder & rescan"
    // click — a track that was disposed of and later reappears on disk (restored from the
    // Recycle Bin, copied back by hand) only gets picked back up as unreviewed on a scan, and
    // requiring the user to remember a manual rescan defeats that. Cheap enough to always do:
    // an unchanged tree's tags aren't re-read (§3.8), measured at ~100ms for this 1000-track
    // fixture. If the scan aborts (unreadable root, empty tree — §3.5's guard), proceed anyway
    // with whatever was already indexed rather than blocking the session entirely; the guard's
    // own job is leaving existing state untouched, not preventing swiping.
    if (root) {
      setStartingSession(true)
      const outcome = await window.purgewave.scan(root)
      setStartingSession(false)
      if (!('aborted' in outcome)) {
        setTrackCount(outcome.total)
        setScan({ phase: 'done', result: outcome })
      }
    }
    const queue = await window.purgewave.sessionStart(limit)
    setView({ name: 'swiping', queue, limit })
  }

  function handleSessionEnd(summary: SessionSummary): void {
    // Review is only worth showing when there's something to confirm; otherwise straight home.
    if (summary.marked === 0) {
      setView({ name: 'library' })
      return
    }
    setView({ name: 'review', sessionKeptIds: summary.keptIds })
  }

  if (view.name === 'resume') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-lg" style={{ color: 'var(--text-primary)' }}>
          <strong>{view.pendingDeletes}</strong> file{view.pendingDeletes === 1 ? ' is' : 's are'} still marked
          for deletion. They&apos;re from your last session and still on disk.
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setView({ name: 'review', sessionKeptIds: [] })}
            className="rounded-xl border px-5 py-3 font-medium"
            style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
          >
            Review them now
          </button>
          <button
            onClick={() => setView({ name: 'sessionPicker' })}
            className="rounded-xl border px-5 py-3 font-medium"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          >
            Keep swiping
          </button>
        </div>
      </div>
    )
  }

  if (view.name === 'sessionPicker') {
    return (
      <div className="flex min-h-screen flex-col">
        <SessionLengthPicker onStart={startSession} starting={startingSession} />
      </div>
    )
  }

  if (view.name === 'swiping') {
    return (
      <div className="flex min-h-screen flex-col">
        <SwipeScreen
          queue={view.queue}
          limit={view.limit}
          onEndSession={handleSessionEnd}
          onThemeChange={setTheme}
        />
      </div>
    )
  }

  if (view.name === 'review') {
    return (
      <div className="flex min-h-screen flex-col">
        <ReviewScreen sessionKeptIds={view.sessionKeptIds} onDone={() => setView({ name: 'library' })} />
      </div>
    )
  }

  if (view.name === 'restore') {
    return (
      <div className="flex min-h-screen flex-col">
        <RestoreScreen onDone={() => setView({ name: 'library' })} />
      </div>
    )
  }

  if (view.name === 'settings') {
    return (
      <div className="flex min-h-screen flex-col">
        <SettingsScreen onThemeChange={setTheme} onDone={() => setView({ name: 'library' })} />
      </div>
    )
  }

  if (view.name === 'stats') {
    return (
      <div className="flex min-h-screen flex-col">
        <StatsScreen onDone={() => setView({ name: 'library' })} />
      </div>
    )
  }

  const scanning = scan.phase === 'scanning'
  const showQuarantineAction = !!quarantineFolder && quarantineCount > 0

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        PurgeWave
      </h1>

      {/* Folder section is the orientation anchor for the whole screen — shown prominently, with
          its own status messages, rather than a single line of code-styled text. */}
      <div
        className="flex flex-col gap-3 rounded-2xl border p-4"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--surface-raised)' }}
      >
        <div>
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
            Music folder
          </p>
          {root ? (
            <p className="mt-1 truncate text-base font-medium" style={{ color: 'var(--text-primary)' }} title={root}>
              {root}
            </p>
          ) : (
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              No folder chosen yet
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleChooseFolder}
            disabled={scanning}
            className="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
          >
            {root ? 'Change Folder' : 'Choose Folder'}
          </button>
          {root && (
            <button
              onClick={() => runScan(root)}
              disabled={scanning}
              className="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-40"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            >
              Scan
            </button>
          )}
        </div>

        {scanning && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Scanning… {scan.progress ? `${scan.progress.scanned} / ${scan.progress.total}` : 'starting'}
          </p>
        )}

        {scan.phase === 'done' && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Scan complete: {scan.result.total} tracks indexed ({scan.result.added} added,{' '}
            {scan.result.updated} updated, {scan.result.missing} newly missing).
          </p>
        )}

        {scan.phase === 'aborted' && (
          <p className="text-sm" style={{ color: 'var(--discard)' }}>
            Can&apos;t reach your music folder
            {scan.reason === 'unreadable-root'
              ? " — it doesn't exist or isn't readable right now."
              : ' — it appears to be empty, which looks like a disconnected drive rather than a real change.'}{' '}
            Nothing was changed. Try again or choose a different folder.
          </p>
        )}

        {scan.phase === 'error' && (
          <p className="text-sm" style={{ color: 'var(--discard)' }}>
            Scan failed: {scan.message}
          </p>
        )}
      </div>

      {/* Primary call to action — the one thing most visits to this screen are here to do. */}
      {trackCount > 0 && (
        <button
          onClick={() => setView({ name: 'sessionPicker' })}
          disabled={scanning}
          className="rounded-xl px-6 py-4 text-lg font-semibold shadow-md disabled:opacity-40"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          Start session
        </button>
      )}

      {/* Secondary, conditional actions — only ever shown when there's actually something to
          act on, so this section can disappear entirely on a freshly-triaged library. */}
      {(pendingDeletes > 0 || showQuarantineAction) && (
        <div className="flex flex-col gap-2">
          {pendingDeletes > 0 && (
            <button
              onClick={() => setView({ name: 'review', sessionKeptIds: [] })}
              disabled={scanning}
              className="rounded-xl border px-5 py-3 text-left font-medium disabled:opacity-40"
              style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
            >
              Review marked ({pendingDeletes})
            </button>
          )}
          {showQuarantineAction && (
            <button
              onClick={() => setView({ name: 'restore' })}
              disabled={scanning}
              className="rounded-xl border px-5 py-3 text-left font-medium disabled:opacity-40"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            >
              View Quarantine ({quarantineCount})
            </button>
          )}
        </div>
      )}

      {/* Bottom of the hierarchy — reachable but visually the least emphasized thing here. */}
      <div
        className="mt-auto flex justify-center gap-3 border-t pt-4"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <button
          onClick={() => setView({ name: 'settings' })}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <GearIcon size={14} /> Settings
        </button>
        <button
          onClick={() => setView({ name: 'stats' })}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <BarChartIcon size={14} /> Stats
        </button>
      </div>
    </div>
  )
}

export default App
