import { useEffect, useState } from 'react'
import type { DisposalMode, DisposeResult, MarkedTrack, Settings } from '../../../shared/types'
import type { SessionSummary } from './SwipeScreen'

interface Props {
  sessionKeptIds: string[]
  // Only present when this screen was reached right after a session ended — shown as a small
  // summary header up top (per user request: no separate in-between "Session complete" screen
  // anymore, this doubles as that summary). Absent when reached directly from the main menu's
  // "Review Marked" button, which isn't tied to any particular session.
  sessionStats?: SessionSummary
  onDone: () => void
}

type ListName = 'keep' | 'delete'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function confirmLabel(mode: DisposalMode, count: number): string {
  if (mode === 'recycle-bin') return `Move ${count} file${count === 1 ? '' : 's'} to Recycle Bin`
  if (mode === 'quarantine') return `Move ${count} file${count === 1 ? '' : 's'} to Quarantine`
  return `Permanently delete ${count} file${count === 1 ? '' : 's'}`
}

export function ReviewScreen({ sessionKeptIds, sessionStats, onDone }: Props) {
  const [loading, setLoading] = useState(true)
  const [keep, setKeep] = useState<MarkedTrack[]>([])
  const [del, setDel] = useState<MarkedTrack[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<DisposeResult | null>(null)
  const [needsPermanentPrompt, setNeedsPermanentPrompt] = useState<string[] | null>(null)
  const [processing, setProcessing] = useState(false)
  // Deleting is the higher-stakes list, so it's the tab shown by default — but only when there's
  // actually something in it; defaulting to it anyway when it's empty just shows a blank list
  // with nothing to act on. Corrected once the real data loads, below.
  const [activeTab, setActiveTab] = useState<ListName>('delete')

  useEffect(() => {
    Promise.all([window.purgewave.getMarked(sessionKeptIds), window.purgewave.getSettings()]).then(
      ([lists, s]) => {
        setKeep(lists.keep)
        setDel(lists.delete)
        if (lists.delete.length === 0 && lists.keep.length > 0) setActiveTab('keep')
        setSettings(s)
        setLoading(false)
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bug found in real use: this used to only update the local `del`/`keep` arrays that drive this
  // screen's own tabs, never actually persisting the flipped decision — so flipping everything in
  // "Purging" over to "Keeping" (emptying `del` to 0) left no way to save that: the confirm button
  // is disabled once `del.length === 0`, and clicking "Back" without ever calling `track:decide`
  // meant decisions.json still had every one of them marked `delete`, so "Review marked" came right
  // back with the same count next time. Fixed by writing the flip straight through, matching how
  // SwipeScreen's own commit() persists a decision — DecisionsStore updates its in-memory copy
  // synchronously (see CLAUDE.md), so pendingDeletes/getMarked reflect this immediately even before
  // the debounced disk write lands.
  function flip(id: string, from: ListName): void {
    if (from === 'delete') {
      const row = del.find((t) => t.id === id)
      if (!row) return
      // Flipping the very last "Purging" row away would otherwise leave the user staring at the
      // same blank-list problem this screen's initial tab choice already guards against — jump
      // over to "Keeping" the same way.
      if (del.length === 1) setActiveTab('keep')
      setDel((d) => d.filter((t) => t.id !== id))
      setKeep((k) => [...k, row])
      window.purgewave.decide(id, 'keep')
    } else {
      const row = keep.find((t) => t.id === id)
      if (!row) return
      setKeep((k) => k.filter((t) => t.id !== id))
      setDel((d) => [...d, row])
      window.purgewave.decide(id, 'delete')
    }
  }

  async function setDisposalMode(mode: DisposalMode): Promise<void> {
    if (!settings) return
    const next = { ...settings, disposalMode: mode }
    setSettings(next)
    await window.purgewave.updateSettings({ disposalMode: mode })
  }

  async function pickQuarantineFolder(): Promise<void> {
    const chosen = await window.purgewave.chooseQuarantineFolder()
    if ('cancelled' in chosen) return
    if (!settings) return
    const next = { ...settings, quarantineFolder: chosen.path }
    setSettings(next)
    await window.purgewave.updateSettings({ quarantineFolder: chosen.path })
  }

  async function runDispose(trackIds: string[]): Promise<void> {
    if (!settings) return
    setProcessing(true)
    const r = await window.purgewave.confirmDispose(trackIds, settings.disposalMode)
    setProcessing(false)
    if (r.needsPermanentPrompt.length > 0) {
      setNeedsPermanentPrompt(r.needsPermanentPrompt)
    }
    setResult(r)
  }

  async function runPermanentForPrompted(): Promise<void> {
    if (!needsPermanentPrompt) return
    setProcessing(true)
    const r = await window.purgewave.confirmPermanent(needsPermanentPrompt)
    setProcessing(false)
    setNeedsPermanentPrompt(null)
    setResult((prev) =>
      prev
        ? {
            ...prev,
            disposed: prev.disposed + r.disposed,
            bytesReclaimed: prev.bytesReclaimed + r.bytesReclaimed,
            failed: [...prev.failed, ...r.failed]
          }
        : r
    )
  }

  if (loading || !settings) {
    return <div className="p-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading review…</div>
  }

  if (keep.length === 0 && del.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-1 flex-col items-center gap-3 p-6 text-center">
        <p style={{ color: 'var(--text-secondary)' }}>Nothing marked for keeping or deletion right now.</p>
        <button
          onClick={onDone}
          className="rounded-xl border px-6 py-3 font-medium"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          Back
        </button>
      </div>
    )
  }

  if (result && !needsPermanentPrompt) {
    return (
      <div className="mx-auto flex max-w-md flex-1 flex-col gap-3 p-6 text-center">
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          {result.mode === 'quarantine' ? 'Moved' : 'Disposed'}
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          {result.disposed} file{result.disposed === 1 ? '' : 's'}{' '}
          {result.mode === 'quarantine'
            ? `moved, ${formatBytes(result.bytesMoved)}`
            : `disposed, ${formatBytes(result.bytesReclaimed)} reclaimed`}
        </p>
        {result.sidecarsDisposed > 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {result.sidecarsDisposed} sidecar file{result.sidecarsDisposed === 1 ? '' : 's'} taken along
          </p>
        )}
        {result.foldersRemoved > 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {result.foldersRemoved} now-empty folder{result.foldersRemoved === 1 ? '' : 's'} removed
          </p>
        )}
        {result.failed.length > 0 && (
          <div className="mt-2 rounded-lg border p-3 text-left text-sm" style={{ borderColor: 'var(--discard)' }}>
            <p style={{ color: 'var(--discard)' }}>{result.failed.length} failed:</p>
            {result.failed.map((f) => (
              <p key={f.path} className="truncate" style={{ color: 'var(--text-muted)' }}>
                {f.path} — {f.reason}
              </p>
            ))}
          </div>
        )}
        <button
          onClick={onDone}
          className="mt-4 rounded-xl border px-6 py-3 font-medium"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          Done
        </button>
      </div>
    )
  }

  if (needsPermanentPrompt) {
    return (
      <div className="mx-auto flex max-w-md flex-1 flex-col gap-3 p-6 text-center">
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          This drive has no Recycle Bin
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          {needsPermanentPrompt.length} file{needsPermanentPrompt.length === 1 ? '' : 's'} can&apos;t be moved
          there. Deleting {needsPermanentPrompt.length === 1 ? 'it' : 'them'} here removes{' '}
          {needsPermanentPrompt.length === 1 ? 'it' : 'them'} permanently — Windows can&apos;t restore{' '}
          {needsPermanentPrompt.length === 1 ? 'it' : 'them'}.
        </p>
        <div className="mt-2 flex justify-center gap-3">
          <button
            onClick={runPermanentForPrompted}
            disabled={processing}
            className="rounded-xl border px-5 py-3 font-medium"
            style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
          >
            Delete permanently
          </button>
          <button
            onClick={() => setNeedsPermanentPrompt(null)}
            className="rounded-xl border px-5 py-3 font-medium"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          >
            Skip these files
          </button>
        </div>
      </div>
    )
  }

  return (
    // h-screen (not flex-1) caps this at the viewport height, which is what lets the list below
    // scroll internally instead of pushing the Back/action row off the bottom of a long list —
    // that row is a normal shrink-0 flex sibling here, "sticky" simply because it always has room
    // to sit in view within this fixed-height column.
    <div className="mx-auto flex h-screen w-full max-w-lg flex-col gap-4 p-6">
      {/* This session's own headline numbers — the "N left in this session" heading's kept/purged
          subheadings from the swipe screen, reused here as the top of what's now the session's one
          and only end-of-session summary (see the Props comment on sessionStats). */}
      {sessionStats && (
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <span className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {sessionStats.reviewed} reviewed
          </span>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span style={{ color: 'var(--discard)' }}>{sessionStats.marked} Purged</span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ color: 'var(--keep)' }}>{sessionStats.kept} Kept</span>
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
        <div className="flex items-center gap-3">
          <span>Disposal:</span>
          {(['recycle-bin', 'quarantine', 'permanent'] as DisposalMode[]).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" checked={settings.disposalMode === m} onChange={() => setDisposalMode(m)} />
              {m === 'recycle-bin' ? 'Recycle Bin' : m === 'quarantine' ? 'Quarantine folder' : 'Permanent'}
            </label>
          ))}
          {settings.disposalMode === 'quarantine' && (
            <button onClick={pickQuarantineFolder} className="underline" style={{ color: 'var(--accent)' }}>
              {settings.quarantineFolder ? 'Change folder' : 'Choose folder'}
            </button>
          )}
        </div>
      </div>

      {/* A real segmented control now, not just colored text — a contained pill-shaped tray
          (its own background, rounded) holding both tabs, with the active one getting a
          tinted fill of its own so it reads as a pressed/selected tab, not just brighter text. */}
      <div className="flex shrink-0 gap-1 rounded-xl p-1" style={{ backgroundColor: 'var(--surface-raised)' }}>
        {(['delete', 'keep'] as ListName[]).map((tab) => {
          const active = activeTab === tab
          const tint = tab === 'delete' ? 'var(--discard)' : 'var(--keep)'
          const count = tab === 'delete' ? del.length : keep.length
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="flex-1 rounded-lg px-4 py-2 text-sm font-semibold"
              style={{
                backgroundColor: active ? `color-mix(in srgb, ${tint} 22%, transparent)` : 'transparent',
                color: active ? tint : 'var(--text-muted)'
              }}
            >
              {tab === 'delete' ? 'Purging' : 'Keeping'} ({count})
              {tab === 'delete' && del.length > 0
                ? ` — ${formatBytes(del.reduce((s, t) => s + t.size, 0))}`
                : ''}
            </button>
          )
        })}
      </div>

      <ul className="flex flex-1 flex-col gap-1.5 overflow-y-auto">
        {(activeTab === 'delete' ? del : keep).map((t) => {
          const tint = activeTab === 'delete' ? 'var(--discard)' : 'var(--keep)'
          return (
            <li
              key={t.id}
              className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: `color-mix(in srgb, ${tint} 35%, var(--border-subtle))`,
                backgroundColor: `color-mix(in srgb, ${tint} 8%, transparent)`
              }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>
                  {t.title}
                </p>
                <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {t.artist}
                </p>
              </div>
              {activeTab === 'delete' ? (
                <button onClick={() => flip(t.id, 'delete')} className="shrink-0 underline" style={{ color: 'var(--keep)' }}>
                  Keep instead
                </button>
              ) : (
                <button onClick={() => flip(t.id, 'keep')} className="shrink-0 underline" style={{ color: 'var(--discard)' }}>
                  Purge instead
                </button>
              )}
            </li>
          )
        })}
        {(activeTab === 'delete' ? del : keep).length === 0 && (
          <li className="py-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Nothing here.
          </li>
        )}
      </ul>

      <div className="flex shrink-0 justify-between border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <button onClick={onDone} className="text-sm underline" style={{ color: 'var(--text-muted)' }}>
          Back
        </button>
        {confirming ? (
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {del.length} file{del.length === 1 ? '' : 's'}, {formatBytes(del.reduce((s, t) => s + t.size, 0))}
              {settings.disposalMode === 'quarantine' ? ` → ${settings.quarantineFolder}` : ''}. Sure?
            </span>
            <button
              onClick={() => runDispose(del.map((t) => t.id))}
              disabled={processing || (settings.disposalMode === 'quarantine' && !settings.quarantineFolder)}
              className="rounded-xl border px-4 py-2 text-sm font-medium"
              style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
            >
              {processing ? 'Working…' : 'Yes, proceed'}
            </button>
          </div>
        ) : del.length === 0 ? (
          // Nothing left to purge — either nothing ever was, or everything got flipped back to
          // "keep" (each flip already persists immediately via decide() above). The disposal
          // button has nothing to do in this state; rather than leaving it disabled and forcing
          // the user to notice that and fall back to the muted "Back" link, this becomes the
          // primary, clickable action instead.
          <button
            onClick={onDone}
            className="rounded-xl border px-5 py-3 font-medium"
            style={{ borderColor: 'var(--keep)', color: 'var(--keep)' }}
          >
            Done — nothing to purge
          </button>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="rounded-xl border px-5 py-3 font-medium"
            style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
          >
            {confirmLabel(settings.disposalMode, del.length)}
          </button>
        )}
      </div>
    </div>
  )
}
