import { useEffect, useState } from 'react'
import type { ScanProgress, ScanResult, SessionLimit } from '../../shared/types'
import { SessionLengthToggle, getLastSessionLimit, rememberSessionLimit } from './session/SessionLengthPicker'
import { SwipeScreen, type SessionSummary } from './session/SwipeScreen'
import { ReviewScreen } from './session/ReviewScreen'
import { RestoreScreen } from './session/RestoreScreen'
import { SettingsScreen } from './session/SettingsScreen'
import { GearIcon } from './session/icons'
import { Logo } from './Logo'

type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning'; progress: ScanProgress | null }
  | { phase: 'done'; result: ScanResult }
  | { phase: 'aborted'; reason: 'unreadable-root' | 'empty-scan' }
  | { phase: 'error'; message: string }

type View =
  | { name: 'library' }
  | { name: 'swiping'; queue: string[]; limit: SessionLimit }
  | { name: 'review'; sessionKeptIds: string[]; sessionStats?: SessionSummary }
  | { name: 'restore' }
  | { name: 'settings' }

// Truncates from the START, keeping the destination folder (the end of the path, and the part
// that actually distinguishes one library from another) visible — a real ellipsis character
// prepended in JS, not CSS `text-overflow` with a flipped `direction: rtl`. That CSS trick was
// tried first and looked right for long paths, but broke on short ones: a leading neutral
// character (an absolute path's own leading "/") gets reordered by the bidi algorithm in an RTL
// paragraph and silently dropped from the visible line entirely, even with nothing actually
// truncated — caught by screenshotting a short path, not by inspection. Plain string slicing has
// no direction/bidi involved at all, so it can't have that failure mode; `title` still carries the
// untruncated path for anyone who wants to inspect it beyond the character-count estimate here.
function truncatePathStart(path: string, maxChars = 40): string {
  if (path.length <= maxChars) return path
  return `…${path.slice(path.length - (maxChars - 1))}`
}

function App() {
  const [root, setRoot] = useState<string | null>(null)
  const [trackCount, setTrackCount] = useState(0)
  const [scan, setScan] = useState<ScanState>({ phase: 'idle' })
  const [view, setView] = useState<View>({ name: 'library' })
  const [startingSession, setStartingSession] = useState(false)
  const [pendingDeletes, setPendingDeletes] = useState(0)
  const [quarantineFolder, setQuarantineFolder] = useState<string | null>(null)
  const [quarantineCount, setQuarantineCount] = useState(0)
  const [sessionLimit, setSessionLimit] = useState<SessionLimit>(() => getLastSessionLimit())
  // Dev-only, purely visual override — lets the empty "no folder chosen" state be previewed
  // without touching the real persisted root/library at all (toggling it back is instant, no
  // rescan needed). Never rendered in a packaged build (import.meta.env.DEV is false there).
  const [devHideFolder, setDevHideFolder] = useState(false)

  useEffect(() => {
    // No more forced "N files still marked for purge" interruption on launch (§6.2's original
    // behavior) — per user feedback, leftover marks from a prior session should just carry
    // forward silently and surface next time a session actually completes (see handleSessionEnd),
    // not block the very first thing the user sees on relaunch.
    window.purgewave.getState().then((state) => {
      setRoot(state.root)
      setTrackCount(state.trackCount)
      setPendingDeletes(state.pendingDeletes)
    })
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

  // Review now doubles as the session summary (see ReviewScreen's own sessionStats header) — it's
  // the only screen shown after a session ends at all, so it's worth showing whenever the session
  // actually did something (reviewed at least one card) or there are marks left over from a prior
  // one that were never surfaced (see the mount effect above: those no longer force a launch-time
  // interruption, they just ride along silently until the next time a session ends). A session
  // where literally nothing happened (End Session hit immediately, nothing left over either) has
  // nothing to summarize, so that one case still goes straight home.
  function handleSessionEnd(summary: SessionSummary): void {
    if (summary.reviewed === 0 && pendingDeletes === 0) {
      setView({ name: 'library' })
      return
    }
    setView({ name: 'review', sessionKeptIds: summary.keptIds, sessionStats: summary })
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
        <ReviewScreen
          sessionKeptIds={view.sessionKeptIds}
          sessionStats={view.sessionStats}
          onDone={() => setView({ name: 'library' })}
        />
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
        <SettingsScreen onDone={() => setView({ name: 'library' })} />
      </div>
    )
  }

  const scanning = scan.phase === 'scanning'
  const showQuarantineAction = !!quarantineFolder && quarantineCount > 0
  // See the devHideFolder state comment above — purely a display override, real `root`/
  // `trackCount` are untouched so toggling back needs no rescan.
  const displayRoot = import.meta.env.DEV && devHideFolder ? null : root
  const displayTrackCount = import.meta.env.DEV && devHideFolder ? 0 : trackCount

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 p-8">
      {/* Real logotype now (see Logo.tsx) — the icon mark and "PURGEWAVE" wordmark are baked into
          one path, so this single element replaces both the old placeholder badge and the
          separate <h1> text it sat next to. An actual <h1> is kept for document structure/screen
          readers (visually hidden), since the SVG itself only carries an aria-label. */}
      <h1 className="sr-only">PurgeWave</h1>
      <Logo className="h-auto w-64" style={{ color: 'var(--accent)' }} />

      {/* Folder section is the orientation anchor for the whole screen — shown prominently, with
          its own status messages, rather than a single line of code-styled text. */}
      <div
        className="flex w-full flex-col items-center gap-3 rounded-2xl border p-4 text-center"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--surface-raised)' }}
      >
        <div className="w-full">
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
            Music folder
          </p>
          {displayRoot ? (
            // Centered like everything else in this card (inherits `text-center` from the card
            // container below) — truncatePathStart already did the only truncation this needs, so
            // `truncate`/`title` here are just a defensive backstop for the rare path that's still
            // too wide for the card even after that.
            <p className="mt-1 truncate text-base font-medium" style={{ color: 'var(--text-primary)' }} title={displayRoot}>
              {truncatePathStart(displayRoot)}
            </p>
          ) : (
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              No folder chosen yet
            </p>
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <button
            onClick={handleChooseFolder}
            disabled={scanning}
            className="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
          >
            {displayRoot ? 'Change Folder' : 'Choose Folder'}
          </button>
          {root && !(import.meta.env.DEV && devHideFolder) && (
            <button
              onClick={() => runScan(root)}
              disabled={scanning}
              className="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-40"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            >
              Scan
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              onClick={() => setDevHideFolder((v) => !v)}
              className="rounded-xl border px-4 py-2 text-xs font-medium"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
              title="Dev-only: preview the main menu with no folder chosen, without touching the real library"
            >
              {devHideFolder ? 'Restore Folder (Dev)' : 'Clear Folder (Dev)'}
            </button>
          )}
        </div>

        {scanning && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Scanning… {scan.progress ? `${scan.progress.scanned} / ${scan.progress.total}` : 'starting'}
          </p>
        )}

        {scan.phase === 'done' && (
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <p>Scan complete: {scan.result.total} tracks indexed.</p>
            <p>
              {scan.result.added} added, {scan.result.updated} updated, {scan.result.missing} newly missing.
            </p>
          </div>
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

      {/* Primary call to action — the one thing most visits to this screen are here to do. Session
          length used to be a separate intermediate screen; it's now just a toggle group living
          right under this button, so choosing a length and starting are the same step. */}
      {displayTrackCount > 0 && (
        <div className="flex w-full flex-col gap-3">
          <SessionLengthToggle
            value={sessionLimit}
            onChange={(limit) => {
              setSessionLimit(limit)
              rememberSessionLimit(limit)
            }}
            disabled={scanning || startingSession}
          />
          <button
            onClick={() => startSession(sessionLimit)}
            disabled={scanning || startingSession}
            className="w-full rounded-xl px-6 py-4 text-lg font-semibold shadow-md disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            {startingSession ? 'Checking for changes…' : 'Start Purging'}
          </button>
        </div>
      )}

      {/* Secondary, conditional actions — only ever shown when there's actually something to
          act on, so this section can disappear entirely on a freshly-triaged library. */}
      {!(import.meta.env.DEV && devHideFolder) && (pendingDeletes > 0 || showQuarantineAction) && (
        <div className="flex w-full flex-col gap-2">
          {pendingDeletes > 0 && (
            <button
              onClick={() => setView({ name: 'review', sessionKeptIds: [] })}
              disabled={scanning}
              className="w-full rounded-xl border px-5 py-3 text-center font-medium disabled:opacity-40"
              style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
            >
              Review Marked ({pendingDeletes})
            </button>
          )}
          {showQuarantineAction && (
            <button
              onClick={() => setView({ name: 'restore' })}
              disabled={scanning}
              className="w-full rounded-xl border px-5 py-3 text-center font-medium disabled:opacity-40"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            >
              View Quarantine ({quarantineCount})
            </button>
          )}
        </div>
      )}

      {/* Bottom of the hierarchy — reachable but visually the least emphasized thing here. Part of
          the same centered group as everything above now (no more mt-auto pinning it to the
          window's bottom edge). Lifetime Stats used to live here too — removed per user request in
          favor of session stats shown at the top of the summary/review screen instead. */}
      <div className="flex w-full justify-center gap-3 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          onClick={() => setView({ name: 'settings' })}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <GearIcon size={14} /> Settings
        </button>
      </div>
    </div>
  )
}

export default App
