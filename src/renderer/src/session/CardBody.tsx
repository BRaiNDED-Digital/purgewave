import { useState } from 'react'
import type { Card as CardData } from '../../../shared/types'

interface Props {
  card: CardData
  artworkGradient: string | null
  aspectRatio: number
  /** Only meaningful (and only rendered) for the true interactive front card. */
  isFront: boolean
  isPlaying: boolean
  onTogglePlay?: () => void
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * The card's visual content — artwork box (sized to the real image's aspect ratio, not force-
 * cropped into a fixed box) plus the text panel below. Deliberately has no motion/drag logic of
 * its own so it can be rendered twice: once inside the real, animated `SwipeCard`, and once as an
 * invisible, normal-flow "sizer" in `SwipeScreen` — every visible `SwipeCard` is `position:
 * absolute`, which means none of them can establish their shared stack container's height on
 * their own, so the sizer's job is purely to give that container a real height to fill, matching
 * whatever the front card's own content naturally needs.
 */
export function CardBody({ card, artworkGradient, aspectRatio, isFront, isPlaying, onTogglePlay }: Props) {
  const [playHovered, setPlayHovered] = useState(false)
  return (
    <>
      <div
        className="relative w-full shrink-0"
        style={{ aspectRatio, background: 'var(--surface-overlay)' }}
      >
        {card.artDataUrl ? (
          <img src={card.artDataUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-6xl font-semibold"
            style={{ color: 'var(--text-muted)' }}
          >
            {card.artist ? card.artist[0]?.toUpperCase() : '♪'}
          </div>
        )}

        <span
          className="absolute bottom-3 left-3 z-20 rounded-full px-2 py-0.5 text-xs font-medium backdrop-blur-sm"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--surface-base) 55%, transparent)',
            color: 'var(--text-primary)'
          }}
        >
          {formatDuration(card.durationSec)}
        </span>

        {isFront && onTogglePlay && !card.previewUnsupported && (
          <button
            aria-label={isPlaying ? 'Pause' : 'Play'}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onMouseEnter={() => setPlayHovered(true)}
            onMouseLeave={() => setPlayHovered(false)}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePlay()
            }}
            // Centered at 50% of the artwork's own height/width, not a fixed corner offset, since
            // the artwork box's height now varies per card (aspect-ratio driven, see above).
            // Hover-darkening is done via React state → inline style, not a CSS `:hover` class:
            // the global button-hover rule in styles.css (`button:not(:disabled):hover`) beats a
            // plain Tailwind `hover:bg-[...]` class on specificity (it carries an extra `button`
            // type-selector), so a CSS-only hover here would have been silently overridden by
            // that generic rule instead of applying this button's own darker background.
            className="absolute top-1/2 left-1/2 z-20 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full backdrop-blur-sm"
            style={{ backgroundColor: `color-mix(in srgb, var(--surface-base) ${playHovered ? 80 : 60}%, transparent)` }}
          >
            {isPlaying ? (
              <svg width="24" height="24" viewBox="0 0 16 16" fill="var(--text-primary)">
                <rect x="3" y="2" width="4" height="12" rx="1" />
                <rect x="9" y="2" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 16 16" fill="var(--text-primary)">
                <path d="M4 2.5v11a1 1 0 0 0 1.53.85l8.5-5.5a1 1 0 0 0 0-1.7l-8.5-5.5A1 1 0 0 0 4 2.5z" />
              </svg>
            )}
          </button>
        )}
      </div>

      <div
        className="relative flex flex-col gap-1 p-5"
        style={{
          // This is the only place the artwork gradient is actually visible — the artwork box
          // above is opaque and, together with this panel, exactly covers the card's root, so a
          // gradient painted on the root itself (an earlier version of this) was never seen at
          // all. Layered directly over the solid surface tone (not further dimmed by a color-mix
          // wrapper) so it reads as a real, noticeable tint rather than a barely-there hint — the
          // hook's own alpha values (useArtworkGradient.ts) are what keep it from overpowering
          // the text, softened further by the blur so it never reads as a hard-edged color patch.
          // Trade-off, accepted deliberately: this can't offer the same guaranteed WCAG AA margin
          // the flat surface tokens were tuned against (styles.css), since it now varies by
          // track. If a specific track's art ever makes text hard to read, the real fix is
          // adaptive text color from measured background luminance — not built here.
          background: artworkGradient ? `${artworkGradient}, var(--surface-raised)` : 'var(--surface-raised)',
          backdropFilter: artworkGradient ? 'blur(28px) saturate(1.4)' : undefined,
          WebkitBackdropFilter: artworkGradient ? 'blur(28px) saturate(1.4)' : undefined
        }}
      >
        <h2 className="truncate text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          {card.title}
          {card.titleIsFilenameFallback && (
            <span className="ml-2 align-middle text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
              (filename)
            </span>
          )}
        </h2>
        <p className="truncate text-lg" style={{ color: 'var(--text-secondary)' }}>
          {card.artist || 'Unknown artist'}
        </p>
        <p className="truncate text-sm" style={{ color: 'var(--text-muted)' }}>
          {[card.album, card.year].filter(Boolean).join(' · ')}
        </p>

        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Added {new Date(card.birthtimeMs).toLocaleDateString()}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {card.format.toUpperCase()}
          {card.bitrate ? ` · ${Math.round(card.bitrate / 1000)}kbps` : ''} ·{' '}
          {(card.size / (1024 * 1024)).toFixed(1)} MB
        </p>

        {card.previewUnsupported && (
          <p className="mt-1 text-xs" style={{ color: 'var(--discard)' }}>
            Can&apos;t preview this file — still swipeable.
          </p>
        )}
      </div>
    </>
  )
}
