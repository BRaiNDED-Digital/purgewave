import { useEffect, useState } from 'react'
import type { ScanProgress, ScanResult, SessionLimit, Theme } from '../../shared/types'
import { SessionLengthPicker } from './session/SessionLengthPicker'
import { SwipeScreen, type SessionSummary } from './session/SwipeScreen'
import { ReviewScreen } from './session/ReviewScreen'
import { RestoreScreen } from './session/RestoreScreen'
import { SettingsScreen } from './session/SettingsScreen'
import { StatsScreen } from './session/StatsScreen'
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

  useTheme(theme)

  useEffect(() => {
    window.purgewave.getSettings().then((s) => setTheme(s.theme))
  }, [])

  useEffect(() => {
    window.purgewave.getState().then((state) => {
      setRoot(state.root)
      setTrackCount(state.trackCount)
      // Shown once per launch (§6.2), before anything else, only when marks actually survived.
      if (!resumeShown && state.pendingDeletes > 0) {
        setResumeShown(true)
        setView({ name: 'resume', pendingDeletes: state.pendingDeletes })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        <SessionLengthPicker onStart={startSession} />
      </div>
    )
  }

  if (view.name === 'swiping') {
    return (
      <div className="flex min-h-screen flex-col">
        <SwipeScreen queue={view.queue} limit={view.limit} onEndSession={handleSessionEnd} />
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

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: 560 }}>
      <h1>PurgeWave</h1>

      {root ? (
        <p>
          Music folder: <code>{root}</code>
        </p>
      ) : (
        <p>No music folder chosen yet.</p>
      )}

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button onClick={handleChooseFolder} disabled={scan.phase === 'scanning'}>
          {root ? 'Change folder & rescan' : 'Choose music folder'}
        </button>
        {trackCount > 0 && (
          <button onClick={() => setView({ name: 'sessionPicker' })} disabled={scan.phase === 'scanning'}>
            Start session
          </button>
        )}
        {trackCount > 0 && (
          <button onClick={() => setView({ name: 'review', sessionKeptIds: [] })} disabled={scan.phase === 'scanning'}>
            Review marked
          </button>
        )}
        <button onClick={() => setView({ name: 'restore' })} disabled={scan.phase === 'scanning'}>
          Restore moved files
        </button>
        <button onClick={() => setView({ name: 'settings' })} disabled={scan.phase === 'scanning'}>
          Settings
        </button>
        <button onClick={() => setView({ name: 'stats' })} disabled={scan.phase === 'scanning'}>
          Stats
        </button>
      </div>

      {scan.phase === 'scanning' && (
        <p>
          Scanning…{' '}
          {scan.progress ? `${scan.progress.scanned} / ${scan.progress.total}` : 'starting'}
        </p>
      )}

      {scan.phase === 'done' && (
        <p>
          Scan complete: {scan.result.total} tracks indexed ({scan.result.added} added,{' '}
          {scan.result.updated} updated, {scan.result.missing} newly missing).
        </p>
      )}

      {scan.phase === 'aborted' && (
        <p style={{ color: 'crimson' }}>
          Can&apos;t reach your music folder
          {scan.reason === 'unreadable-root'
            ? " — it doesn't exist or isn't readable right now."
            : ' — it appears to be empty, which looks like a disconnected drive rather than a real change.'}{' '}
          Nothing was changed. Try again or choose a different folder.
        </p>
      )}

      {scan.phase === 'error' && <p style={{ color: 'crimson' }}>Scan failed: {scan.message}</p>}
    </main>
  )
}

export default App
