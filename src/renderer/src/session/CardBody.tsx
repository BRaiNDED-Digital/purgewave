import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import type { Card as CardData } from '../../../shared/types'
import { SpeakerIcon } from './icons'

interface Props {
  card: CardData
  artworkGradient: string | null
  aspectRatio: number
  /** Only meaningful (and only rendered) for the true interactive front card. */
  isFront: boolean
  isPlaying: boolean
  onTogglePlay?: () => void
  /** Volume control, also only meaningful for the true interactive front card. */
  volume?: number
  onVolumeChange?: (volume: number) => void
  /** Live playback position (seconds), also only meaningful for the true interactive front card —
   *  when present, the time pill reads "current / total" instead of just the static total. */
  currentTime?: number
}

function MetaBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--surface-base) 55%, transparent)',
        color: 'var(--text-secondary)'
      }}
    >
      {/* Nudged down 1px independent of the pill's own padding — the pill shape stays put, only
          the glyphs shift, since text in this font otherwise sits a hair high inside the pill. */}
      <span className="inline-block translate-y-px">{children}</span>
    </span>
  )
}

/** A larger, standalone pill just for the duration — bigger than the format/bitrate/size
 *  MetaBadges above, since it's the one piece of metadata called out as worth more visual
 *  weight, not another small chip in that same row. */
function TimePill({ children }: { children: ReactNode }) {
  return (
    <span
      // h-8, matching the volume pill's own fixed height exactly (that one sets it via its
      // outer motion.div, not padding) — both pills sit in the same corner-to-corner row across
      // the artwork, so they need to line up on the same height, not just look similar-sized.
      // Same 3px blur / 40% opacity as the volume pill and the play/pause overlay, for one
      // consistent frosted-glass treatment across every control on the artwork.
      className="flex h-8 items-center rounded-full px-3 text-sm font-semibold backdrop-blur-[3px]"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--surface-base) 40%, transparent)',
        color: 'var(--text-primary)'
      }}
    >
      {children}
    </span>
  )
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
export function CardBody({
  card,
  artworkGradient,
  aspectRatio,
  isFront,
  isPlaying,
  onTogglePlay,
  volume,
  onVolumeChange,
  currentTime
}: Props) {
  const [playHovered, setPlayHovered] = useState(false)
  const [volumeHovered, setVolumeHovered] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)

  // Closes the volume popover on any click elsewhere. Added only while open, and only after the
  // triggering click has already finished bubbling (this effect runs after that render commits),
  // so the same click that opens the popover can never also close it.
  useEffect(() => {
    if (!volumeOpen) return
    const close = (): void => setVolumeOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [volumeOpen])

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

        {/* Duration pill, top-left of the artwork — mirrors the volume control's top-right
            position. Moved back here from the text panel (it briefly lived as its own bold line
            under artist/album) per revised design. Reads "current / total" once playback has a
            real position to report (only ever true for the front card); other cards just show the
            static total, same as before. */}
        <div className="absolute top-3 left-3 z-20">
          <TimePill>
            {currentTime !== undefined
              ? `${formatDuration(currentTime)} / ${formatDuration(card.durationSec)}`
              : formatDuration(card.durationSec)}
          </TimePill>
        </div>

        {isFront && onVolumeChange && volume !== undefined && (
          // One unified pill background (not a separate icon-pill plus a separate slider-pill) —
          // anchored at `right-3`, so animating its own width grows it leftward: the icon (first
          // in flex order, therefore the leftmost content) visibly slides left as the box extends,
          // and the slider is revealed to its right, inside that same growing container.
          <div
            className="absolute top-3 right-3 z-20"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <motion.div
              initial={false}
              animate={{ width: volumeOpen ? 152 : 32 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              onMouseEnter={() => setVolumeHovered(true)}
              onMouseLeave={() => setVolumeHovered(false)}
              // Same 3px blur as the time pill and the play/pause overlay, and the exact same
              // 40%-idle/65%-hover backdrop shift as play/pause — hover feedback here is this
              // background brightening, not the global button hover rule (which would also add an
              // unwanted lift), so the inner button below explicitly opts out of that.
              className="flex h-8 items-center overflow-hidden rounded-full backdrop-blur-[3px]"
              style={{ backgroundColor: `color-mix(in srgb, var(--surface-base) ${volumeHovered ? 65 : 40}%, transparent)` }}
            >
              <button
                aria-label="Volume"
                onClick={(e) => {
                  e.stopPropagation()
                  setVolumeOpen((v) => !v)
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{ color: 'var(--text-primary)', backgroundColor: 'transparent' }}
              >
                <SpeakerIcon size={17} muted={volume === 0} />
              </button>
              <motion.div
                initial={false}
                animate={{ opacity: volumeOpen ? 1 : 0 }}
                transition={{ duration: 0.15, delay: volumeOpen ? 0.1 : 0 }}
                className="flex min-w-0 flex-1 items-center pr-3"
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => onVolumeChange(Number(e.target.value))}
                  className="w-full"
                />
              </motion.div>
            </motion.div>
          </div>
        )}

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
            // h-16/w-16 (down from h-20/w-20) and a 3px backdrop-blur (between the Tailwind "sm"
            // preset's 4px and the earlier 2px) — smaller and less of a frosted patch over the
            // artwork sitting behind it.
            className="absolute top-1/2 left-1/2 z-20 flex aspect-square h-16 w-16 shrink-0 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full backdrop-blur-[3px]"
            style={{
              borderRadius: '9999px',
              // 40% at rest (originally 45%, briefly 32%) — still brightens on hover (65%,
              // unchanged) so the hover feedback stays just as clear.
              backgroundColor: `color-mix(in srgb, var(--surface-base) ${playHovered ? 65 : 40}%, transparent)`
            }}
          >
            {isPlaying ? (
              <svg width="22" height="22" viewBox="0 0 16 16" fill="var(--text-primary)">
                <rect x="3" y="2" width="4" height="12" rx="1" />
                <rect x="9" y="2" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 16 16" fill="var(--text-primary)">
                <path d="M4 2.5v11a1 1 0 0 0 1.53.85l8.5-5.5a1 1 0 0 0 0-1.7l-8.5-5.5A1 1 0 0 0 4 2.5z" />
              </svg>
            )}
          </button>
        )}
      </div>

      <div
        className="relative flex flex-col gap-1 px-5 pt-3 pb-3"
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
        <h2 className="-mt-0.5 truncate text-2xl leading-tight font-semibold" style={{ color: 'var(--text-primary)' }}>
          {card.title}
          {card.titleIsFilenameFallback && (
            <span className="ml-2 align-middle text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
              (filename)
            </span>
          )}
        </h2>
        <p className="truncate text-lg leading-tight" style={{ color: 'var(--text-secondary)' }}>
          {card.artist || 'Unknown artist'}
        </p>
        {card.album && (
          <p className="truncate text-sm leading-tight" style={{ color: 'var(--text-muted)' }}>
            {card.album}
          </p>
        )}

        {/* Bottom row: added date on the left (bold), format/bitrate/size pills on the right —
            opposite corners of the card, across from each other. */}
        <div className="mt-1 flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="font-bold">Added {new Date(card.birthtimeMs).toLocaleDateString()}</span>
          <div className="flex flex-wrap justify-end gap-1.5">
            <MetaBadge>{card.format.toUpperCase()}</MetaBadge>
            {card.bitrate ? <MetaBadge>{Math.round(card.bitrate / 1000)} kbps</MetaBadge> : null}
            <MetaBadge>{(card.size / (1024 * 1024)).toFixed(1)} MB</MetaBadge>
          </div>
        </div>

        {card.previewUnsupported && (
          <p className="mt-1 text-xs" style={{ color: 'var(--discard)' }}>
            Can&apos;t preview this file — still swipeable.
          </p>
        )}
      </div>
    </>
  )
}
