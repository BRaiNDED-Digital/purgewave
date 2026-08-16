import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { motion, useMotionValue, useTransform, animate, type PanInfo } from 'framer-motion'
import type { Card as CardData } from '../../../shared/types'

const COMMIT_DISTANCE_RATIO = 0.35
const COMMIT_VELOCITY = 500
const EXIT_DURATION_MIN_MS = 220
const EXIT_DURATION_MAX_MS = 320
const REDUCED_MOTION_DURATION_MS = 150

export interface SwipeCardHandle {
  /** Plays the same exit as a drag commit, with a synthetic velocity (spec §6.4/§9.3). */
  exit: (direction: 'keep' | 'discard') => void
}

interface Props {
  card: CardData
  /** 0 = interactive front card, 1+ = stacked behind, negative = mid-exit (no longer interactive). */
  stackIndex: number
  reducedMotion: boolean
  /** Fires the instant a decision commits — the data model must advance immediately (§3.7). */
  onCommitted: (direction: 'keep' | 'discard') => void
  /** Fires once the exit animation has visually finished, so the parent can unmount it. */
  onExitAnimationComplete: () => void
  onZoneClick: (zone: 'left' | 'center' | 'right') => void
  /** Set when this mount is an undo restoring the card — it re-enters from the side it left. */
  enterFromExitDirection?: 'keep' | 'discard' | null
}

function exitDurationMs(velocity: number, reducedMotion: boolean): number {
  if (reducedMotion) return REDUCED_MOTION_DURATION_MS
  const fromVelocity = 90000 / Math.max(Math.abs(velocity), 200)
  return Math.min(EXIT_DURATION_MAX_MS, Math.max(EXIT_DURATION_MIN_MS, fromVelocity))
}

export const SwipeCard = forwardRef<SwipeCardHandle, Props>(function SwipeCard(
  { card, stackIndex, reducedMotion, onCommitted, onExitAnimationComplete, onZoneClick, enterFromExitDirection },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const x = useMotionValue(enterFromExitDirection ? (enterFromExitDirection === 'keep' ? 480 : -480) : 0)
  const opacity = useMotionValue(stackIndex > 0 ? 0 : 1)
  const rotate = useTransform(x, [-320, 320], reducedMotion ? [0, 0] : [-8, 8], { clamp: true })
  // §9.3: fades in beyond ~15% of card width, builds to full intensity near the 35% commit
  // threshold. The card's width is fixed by its `max-w-md` container (~448px) rather than
  // measured per-instance, so these are expressed as approximate pixel equivalents of that.
  const keepOpacity = useTransform(x, [67, 155], [0, 1], { clamp: true })
  const discardOpacity = useTransform(x, [-155, -67], [1, 0], { clamp: true })

  const pointerDown = useRef<{ x: number; y: number; t: number } | null>(null)

  // Entry per §9.3: new cards appearing at the back of the stack fade in, no slide/scale. Runs
  // once on mount only — a card's opacity must not re-fade as it advances toward the front.
  useEffect(() => {
    if (stackIndex > 0) void animate(opacity, 1, { duration: reducedMotion ? 0.1 : 0.3 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Undo per §9.3: reverses the exit — re-enters from the side it left, rotation unwinding
  // (rotate is derived from x, so animating x back to 0 unwinds it for free), on a slightly
  // softer spring than the exit.
  useEffect(() => {
    if (enterFromExitDirection) {
      void animate(x, 0, {
        type: 'spring',
        stiffness: reducedMotion ? 600 : 350,
        damping: 30
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isFront = stackIndex === 0

  function playExit(direction: 'keep' | 'discard', velocity: number): void {
    // §9.3: translates 1.4× *viewport* width, not card width — the card and viewport can differ
    // enough (the card is capped by its max-w-md container) that this isn't a rounding matter.
    const target = (direction === 'keep' ? 1 : -1) * window.innerWidth * 1.4
    const durationSec = exitDurationMs(velocity, reducedMotion) / 1000
    onCommitted(direction)
    const controls = animate(x, target, { duration: durationSec, ease: 'easeIn' })
    // Opacity falls to 0 over the last 40% of the exit, not a full extra duration tacked on
    // after it — delay to the 60% mark, then fade over the remaining 40% of the same timeline.
    void animate(opacity, 0, { duration: durationSec * 0.4, ease: 'easeIn', delay: durationSec * 0.6 })
    void controls.then(() => onExitAnimationComplete())
  }

  useImperativeHandle(ref, () => ({
    exit: (direction) => playExit(direction, direction === 'keep' ? 700 : -700)
  }))

  function handleDragEnd(_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo): void {
    const width = containerRef.current?.offsetWidth ?? 320
    const committed =
      Math.abs(info.offset.x) > width * COMMIT_DISTANCE_RATIO || Math.abs(info.velocity.x) > COMMIT_VELOCITY
    if (!committed) {
      void animate(x, 0, { type: 'spring', stiffness: 600, damping: 30 })
      return
    }
    playExit(info.offset.x > 0 ? 'keep' : 'discard', info.velocity.x)
  }

  function handlePointerDown(e: React.PointerEvent): void {
    pointerDown.current = { x: e.clientX, y: e.clientY, t: Date.now() }
  }

  function handlePointerUp(e: React.PointerEvent): void {
    const start = pointerDown.current
    pointerDown.current = null
    if (!start || !isFront) return

    const dx = Math.abs(e.clientX - start.x)
    const dy = Math.abs(e.clientY - start.y)
    const dt = Date.now() - start.t
    if (dx > 5 || dy > 5 || dt > 250) return // a drag that snaps back is not a click

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const relativeX = (e.clientX - rect.left) / rect.width
    const zone = relativeX < 1 / 3 ? 'left' : relativeX > 2 / 3 ? 'right' : 'center'
    onZoneClick(zone)
  }

  // Stack position 0 = interactive front card, negative = mid-exit (still uses the same x/rotate
  // motion values so its animation continues uninterrupted after it stops being "front"). Both
  // freeze scale/y at rest. Positions 1+ sit behind, scaled down and offset, rising into place
  // with the "advance" spring the instant the card ahead of them exits.
  const usesDragPosition = stackIndex <= 0
  const restScale = usesDragPosition ? 1 : Math.max(0.88, 0.94 - 0.06 * (stackIndex - 1))
  const restY = usesDragPosition ? 0 : 12 * stackIndex

  return (
    <motion.div
      ref={containerRef}
      className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border shadow-xl"
      style={{
        x: usesDragPosition ? x : 0,
        rotate: usesDragPosition ? rotate : 0,
        opacity,
        backgroundColor: 'var(--surface-raised)',
        borderColor: 'var(--border-subtle)',
        touchAction: 'none',
        pointerEvents: isFront ? 'auto' : 'none'
      }}
      animate={{ scale: restScale, y: restY }}
      initial={false}
      transition={{ type: 'spring', stiffness: 400, damping: 32, mass: 0.8 }}
      drag={isFront ? 'x' : false}
      dragElastic={0.7}
      dragConstraints={{ left: 0, right: 0 }}
      dragTransition={{ bounceStiffness: 500, bounceDamping: 40 }}
      onDragEnd={handleDragEnd}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      data-testid="swipe-card"
    >
      {isFront && (
        <>
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-1/3"
            style={{ opacity: keepOpacity, background: 'linear-gradient(to left, var(--keep), transparent)' }}
          />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-1/3"
            style={{ opacity: discardOpacity, background: 'linear-gradient(to right, var(--discard), transparent)' }}
          />
        </>
      )}

      <div className="flex flex-1 items-center justify-center" style={{ background: 'var(--surface-overlay)' }}>
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
      </div>

      <div className="flex flex-col gap-1 p-5">
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

        {card.albumContext && (
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Track {card.albumContext.index} of {card.albumContext.total} · {card.albumContext.albumName}
            {card.albumContext.markedForDeletion > 0 &&
              ` · ${card.albumContext.markedForDeletion} marked for deletion`}
          </p>
        )}

        {card.pastReview && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Last reviewed {new Date(card.pastReview.lastReviewedAt).toLocaleDateString()} · seen{' '}
            {card.pastReview.reviewCount}×
          </p>
        )}

        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {card.format.toUpperCase()}
          {card.bitrate ? ` · ${Math.round(card.bitrate / 1000)}kbps` : ''} ·{' '}
          {(card.size / (1024 * 1024)).toFixed(1)} MB ·{' '}
          {new Date(card.birthtimeMs).toLocaleDateString()}
        </p>

        {card.previewUnsupported && (
          <p className="mt-1 text-xs" style={{ color: 'var(--discard)' }}>
            Can&apos;t preview this file — still swipeable.
          </p>
        )}
      </div>
    </motion.div>
  )
})
