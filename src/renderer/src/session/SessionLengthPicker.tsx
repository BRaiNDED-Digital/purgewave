import type { SessionLimit } from '../../../shared/types'

const OPTIONS: { label: string; limit: SessionLimit }[] = [
  { label: '10', limit: 10 },
  { label: '25', limit: 25 },
  { label: '50', limit: 50 },
  { label: '100', limit: 100 },
  { label: 'Unlimited', limit: null }
]

const STORAGE_KEY = 'purgewave.lastSessionLimit'

export function getLastSessionLimit(): SessionLimit {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return 25
  if (raw === 'null') return null
  const n = Number(raw)
  return n === 10 || n === 25 || n === 50 || n === 100 ? n : 25
}

function rememberSessionLimit(limit: SessionLimit): void {
  localStorage.setItem(STORAGE_KEY, String(limit))
}

interface Props {
  onStart: (limit: SessionLimit) => void
  /** True while the pre-session rescan (triggered after a limit is picked) is in flight. */
  starting: boolean
}

export function SessionLengthPicker({ onStart, starting }: Props) {
  const last = getLastSessionLimit()

  function choose(limit: SessionLimit): void {
    rememberSessionLimit(limit)
    onStart(limit)
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h2 className="text-xl font-medium" style={{ color: 'var(--text-primary)' }}>
        How many tracks this session?
      </h2>
      <div className="flex flex-wrap justify-center gap-3">
        {OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => choose(opt.limit)}
            autoFocus={opt.limit === last}
            disabled={starting}
            className="rounded-xl border px-6 py-4 text-lg font-medium transition-colors disabled:opacity-40"
            style={{
              borderColor: opt.limit === last ? 'var(--accent)' : 'var(--border-subtle)',
              color: 'var(--text-primary)',
              backgroundColor: 'var(--surface-raised)'
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {starting && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Checking for changes…
        </p>
      )}
    </div>
  )
}
