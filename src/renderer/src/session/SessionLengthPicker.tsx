import type { SessionLimit } from '../../../shared/types'
import { InfinityIcon } from './icons'

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

export function rememberSessionLimit(limit: SessionLimit): void {
  localStorage.setItem(STORAGE_KEY, String(limit))
}

interface Props {
  value: SessionLimit
  onChange: (limit: SessionLimit) => void
  disabled?: boolean
}

/** Inline toggle group living directly under the main menu's "Start session" button (§ per user
 *  request — session length used to be its own intermediate screen; picking a length is now just
 *  part of the main menu itself, and "Start session" reads whichever toggle is currently active. */
export function SessionLengthToggle({ value, onChange, disabled }: Props) {
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <p className="text-xs font-medium tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
        Tracks to Review
      </p>
      <div className="flex w-full flex-wrap justify-center gap-2">
        {OPTIONS.map((opt) => {
          const active = opt.limit === value
          return (
            <button
              key={opt.label}
              onClick={() => onChange(opt.limit)}
              disabled={disabled}
              aria-label={opt.limit === null ? 'Unlimited' : undefined}
              className="rounded-lg border px-3.5 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{
                borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                backgroundColor: active ? 'var(--accent)' : 'transparent',
                color: active ? 'var(--accent-contrast)' : 'var(--text-secondary)'
              }}
            >
              {opt.limit === null ? <InfinityIcon size={22} /> : opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
