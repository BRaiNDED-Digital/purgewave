import { useEffect, useState } from 'react'
import type { LifetimeStats } from '../../../shared/types'

interface Props {
  onDone: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
  )
}

export function StatsScreen({ onDone }: Props) {
  const [stats, setStats] = useState<LifetimeStats | null>(null)

  useEffect(() => {
    window.purgewave.getStats().then(setStats)
  }, [])

  if (!stats) {
    return <div className="p-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading…</div>
  }

  const maxWeekly = Math.max(1, ...stats.weeklyReviewed.map((w) => w.count))

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 p-6">
      <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        Stats
      </h2>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="reviewed" value={String(stats.totalReviewed)} />
        <Stat label="kept" value={String(stats.totalKept)} />
        <Stat label="keep rate" value={`${Math.round(stats.keepRate * 100)}%`} />
        <Stat label="space reclaimed" value={formatBytes(stats.bytesReclaimed)} />
        <Stat label="space moved" value={formatBytes(stats.bytesMoved)} />
        <Stat label="sessions" value={String(stats.sessionsCompleted)} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
          Library: {stats.libraryTotal} tracks, {stats.libraryUnreviewed} unreviewed (
          {Math.round(stats.percentTriaged * 100)}% triaged)
        </span>
        {stats.reviewingSinceAt && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Reviewing since {new Date(stats.reviewingSinceAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {stats.weeklyReviewed.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            Tracks reviewed per week
          </span>
          <div className="flex h-24 items-end gap-1">
            {stats.weeklyReviewed.map((w) => (
              <div key={w.weekStartIso} className="flex flex-1 flex-col items-center gap-1" title={`${w.weekStartIso}: ${w.count}`}>
                <div
                  className="w-full rounded-t"
                  style={{
                    height: `${Math.max(4, (w.count / maxWeekly) * 96)}px`,
                    backgroundColor: 'var(--accent)'
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onDone}
        className="self-start rounded-xl border px-5 py-2 text-sm font-medium"
        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
      >
        Done
      </button>
    </div>
  )
}
