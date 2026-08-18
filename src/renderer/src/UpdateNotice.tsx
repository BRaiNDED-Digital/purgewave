import { useEffect, useState } from 'react'

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'downloaded'; version: string }

/** Plain, subtle text in the bottom-right corner — the running app version, always present. */
export function VersionLabel() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    window.purgewave.getAppVersion().then(setVersion)
  }, [])

  if (!version) return null
  return (
    <span className="fixed right-3 bottom-3 text-xs" style={{ color: 'var(--text-muted)' }}>
      v{version}
    </span>
  )
}

/**
 * Modal, shown the moment a launch-time update check finds something newer — per user request,
 * replacing both the original silent-background-install flow (see updater.ts for why that never
 * actually updated a real install) and a first pass at this that used a dismiss-and-forget corner
 * pill instead of a modal.
 */
export function UpdateModal() {
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const offAvailable = window.purgewave.onUpdateAvailable(({ version }) =>
      setUpdate({ phase: 'available', version })
    )
    const offProgress = window.purgewave.onUpdateProgress(({ percent }) =>
      setUpdate((prev) =>
        prev.phase === 'downloading' || prev.phase === 'available'
          ? { phase: 'downloading', version: prev.version, percent }
          : prev
      )
    )
    const offDownloaded = window.purgewave.onUpdateDownloaded(({ version }) =>
      setUpdate({ phase: 'downloaded', version })
    )
    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
    }
  }, [])

  async function handleDownload(): Promise<void> {
    if (update.phase !== 'available') return
    setUpdate({ phase: 'downloading', version: update.version, percent: 0 })
    try {
      await window.purgewave.downloadUpdate()
    } catch {
      // Failed download: back to "available" so the user can retry from the same modal.
      setUpdate({ phase: 'available', version: update.version })
    }
  }

  function handleInstall(): void {
    void window.purgewave.installUpdate()
  }

  if (update.phase === 'idle' || dismissed) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ backgroundColor: 'color-mix(in srgb, var(--surface-base) 60%, transparent)' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border p-5 shadow-xl"
        style={{ backgroundColor: 'var(--surface-overlay)', borderColor: 'var(--border-subtle)' }}
      >
        {update.phase === 'available' && (
          <>
            <h3 className="mb-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Update available
            </h3>
            <p className="mb-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
              PurgeWave v{update.version} is ready to download.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDismissed(true)}
                className="rounded-xl border px-4 py-2 text-sm font-medium"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                Later
              </button>
              <button
                onClick={handleDownload}
                className="rounded-xl px-4 py-2 text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
              >
                Download
              </button>
            </div>
          </>
        )}

        {update.phase === 'downloading' && (
          <>
            <h3 className="mb-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Downloading update…
            </h3>
            <div
              className="h-2 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--border-subtle)' }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.round(update.percent)}%`, backgroundColor: 'var(--accent)' }}
              />
            </div>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {Math.round(update.percent)}%
            </p>
          </>
        )}

        {update.phase === 'downloaded' && (
          <>
            <h3 className="mb-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Update ready
            </h3>
            <p className="mb-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
              PurgeWave v{update.version} downloaded. Restart to install it.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDismissed(true)}
                className="rounded-xl border px-4 py-2 text-sm font-medium"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                Later
              </button>
              <button
                onClick={handleInstall}
                className="rounded-xl px-4 py-2 text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
              >
                Restart Now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
