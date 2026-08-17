import { useEffect, useState } from 'react'
import type { MarkedTrack } from '../../../shared/types'

interface Props {
  onDone: () => void
}

export function RestoreScreen({ onDone }: Props) {
  const [tracks, setTracks] = useState<MarkedTrack[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<{ restored: number; failed: { path: string; reason: string }[] } | null>(
    null
  )

  useEffect(() => {
    window.purgewave.restoreList().then((list) => {
      setTracks(list)
      setSelected(new Set(list.map((t) => t.id)))
    })
  }, [])

  function toggle(id: string): void {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function run(): Promise<void> {
    const r = await window.purgewave.restoreRun([...selected])
    setResult(r)
  }

  if (result) {
    return (
      <div className="mx-auto flex max-w-md flex-1 flex-col gap-3 p-6 text-center">
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Restored
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>{result.restored} file(s) restored</p>
        {result.failed.length > 0 && (
          <div className="text-left text-sm" style={{ color: 'var(--discard)' }}>
            {result.failed.map((f) => (
              <p key={f.path}>
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

  if (!tracks) {
    return <div className="p-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading…</div>
  }

  if (tracks.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-1 flex-col items-center gap-3 p-6 text-center">
        <p style={{ color: 'var(--text-secondary)' }}>No quarantined files to restore.</p>
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

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 p-6">
      <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        Quarantine ({tracks.length})
      </h2>
      <ul className="flex flex-col gap-1">
        {tracks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
            <span className="truncate">
              {t.title} — {t.artist} ({t.path})
            </span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <button onClick={onDone} className="text-sm underline" style={{ color: 'var(--text-muted)' }}>
          Back
        </button>
        <button
          onClick={run}
          disabled={selected.size === 0}
          className="rounded-xl border px-5 py-3 font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--keep)', color: 'var(--keep)' }}
        >
          Restore {selected.size} file{selected.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
