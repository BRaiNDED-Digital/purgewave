import { useEffect, useState } from 'react'
import type { DisposalMode, DormantTrack, Settings, Theme } from '../../../shared/types'

interface Props {
  onDone: () => void
  onThemeChange: (theme: Theme) => void
}

const DISPOSAL_EXPLANATION: Record<DisposalMode, string> = {
  'recycle-bin': "Windows can restore these from the Recycle Bin if you change your mind later.",
  quarantine:
    'Files move to a folder you choose, fully intact and playable — the gentlest option, a holding pen rather than a deletion.',
  permanent: "This does not go through the Recycle Bin. Windows can't restore these — drives without one will still prompt before anything is destroyed."
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 text-sm" style={{ borderColor: 'var(--border-subtle)' }}>
      {children}
    </div>
  )
}

export function SettingsScreen({ onDone, onThemeChange }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [dormantPreview, setDormantPreview] = useState<DormantTrack[] | null>(null)
  const [forgetResult, setForgetResult] = useState<number | null>(null)

  useEffect(() => {
    window.purgewave.getSettings().then(setSettings)
  }, [])

  async function update(partial: Partial<Settings>): Promise<void> {
    if (!settings) return
    const next = { ...settings, ...partial }
    setSettings(next)
    await window.purgewave.updateSettings(partial)
  }

  async function pickQuarantineFolder(): Promise<void> {
    const chosen = await window.purgewave.chooseQuarantineFolder()
    if ('cancelled' in chosen) return
    await update({ quarantineFolder: chosen.path })
  }

  async function previewForget(): Promise<void> {
    const preview = await window.purgewave.previewForgetDormant()
    setDormantPreview(preview)
  }

  async function confirmForget(): Promise<void> {
    if (!dormantPreview) return
    const { forgotten } = await window.purgewave.forgetDormant(dormantPreview.map((t) => t.id))
    setForgetResult(forgotten)
    setDormantPreview(null)
  }

  if (!settings) {
    return <div className="p-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading…</div>
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-2 p-6">
      <h2 className="mb-2 text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        Settings
      </h2>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Autoplay preview</span>
        <input type="checkbox" checked={settings.autoplay} onChange={(e) => update({ autoplay: e.target.checked })} />
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.volume}
          onChange={(e) => update({ volume: Number(e.target.value) })}
        />
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Normalize volume</span>
        <input
          type="checkbox"
          checked={settings.normalizeVolume}
          onChange={(e) => update({ normalizeVolume: e.target.checked })}
        />
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Preview start position</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.05}
            value={settings.previewStartRatio}
            onChange={(e) => update({ previewStartRatio: Number(e.target.value) })}
          />
          <span className="w-10 text-right text-xs" style={{ color: 'var(--text-muted)' }}>
            {Math.round(settings.previewStartRatio * 100)}%
          </span>
        </div>
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Side-click decisions</span>
        <input
          type="checkbox"
          checked={settings.sideClickDecisions}
          onChange={(e) => update({ sideClickDecisions: e.target.checked })}
        />
      </Row>

      <div className="flex flex-col gap-2 border-b py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--text-primary)' }}>Disposal mode</span>
          <div className="flex gap-3">
            {(['recycle-bin', 'quarantine', 'permanent'] as DisposalMode[]).map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={settings.disposalMode === m}
                  onChange={() => update({ disposalMode: m })}
                />
                {m === 'recycle-bin' ? 'Recycle Bin' : m === 'quarantine' ? 'Move to folder' : 'Permanent'}
              </label>
            ))}
          </div>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {DISPOSAL_EXPLANATION[settings.disposalMode]}
        </p>
        {settings.disposalMode === 'quarantine' && (
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <span className="truncate">{settings.quarantineFolder ?? 'No folder chosen yet'}</span>
            <button onClick={pickQuarantineFolder} className="shrink-0 underline" style={{ color: 'var(--accent)' }}>
              {settings.quarantineFolder ? 'Change' : 'Choose folder'}
            </button>
          </div>
        )}
      </div>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Remove sidecar files</span>
        <input
          type="checkbox"
          checked={settings.removeSidecarFiles}
          onChange={(e) => update({ removeSidecarFiles: e.target.checked })}
        />
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Remove empty folders</span>
        <input
          type="checkbox"
          checked={settings.removeEmptyFolders}
          onChange={(e) => update({ removeEmptyFolders: e.target.checked })}
        />
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Theme</span>
        <div className="flex gap-3 text-sm">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input
                type="radio"
                checked={settings.theme === t}
                onChange={() => {
                  update({ theme: t })
                  onThemeChange(t)
                }}
              />
              {t[0].toUpperCase() + t.slice(1)}
            </label>
          ))}
        </div>
      </Row>

      <Row>
        <span style={{ color: 'var(--text-primary)' }}>Check for updates</span>
        <input
          type="checkbox"
          checked={settings.checkForUpdates}
          onChange={(e) => update({ checkForUpdates: e.target.checked })}
        />
      </Row>

      <div className="flex flex-col gap-2 py-3">
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
          Forget dormant tracks
        </span>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Drops missing records not seen in the last 20 scans. Trashed records are never touched.
        </p>
        {forgetResult !== null ? (
          <p className="text-xs" style={{ color: 'var(--keep)' }}>
            Forgot {forgetResult} record{forgetResult === 1 ? '' : 's'}.
          </p>
        ) : dormantPreview ? (
          dormantPreview.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Nothing dormant enough to forget.</p>
          ) : (
            <div className="flex flex-col gap-2 text-xs">
              <p style={{ color: 'var(--text-secondary)' }}>
                {dormantPreview.length} record{dormantPreview.length === 1 ? '' : 's'} unseen for 20+ scans:
              </p>
              <ul className="flex flex-col gap-1" style={{ color: 'var(--text-muted)' }}>
                {dormantPreview.map((t) => (
                  <li key={t.id} className="truncate">
                    {t.title} — {t.artist} ({t.scansUnseen} scans unseen)
                  </li>
                ))}
              </ul>
              <div className="flex gap-3">
                <button onClick={confirmForget} className="underline" style={{ color: 'var(--discard)' }}>
                  Confirm — forget these
                </button>
                <button onClick={() => setDormantPreview(null)} className="underline" style={{ color: 'var(--text-muted)' }}>
                  Cancel
                </button>
              </div>
            </div>
          )
        ) : (
          <button
            onClick={previewForget}
            className="self-start rounded-lg border px-3 py-1.5 text-xs"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          >
            Check dormant tracks
          </button>
        )}
      </div>

      <button
        onClick={onDone}
        className="mt-4 self-start rounded-xl border px-5 py-2 text-sm font-medium"
        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
      >
        Done
      </button>
    </div>
  )
}
