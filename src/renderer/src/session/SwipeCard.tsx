import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { motion, useMotionValue, useTransform, animate, type PanInfo } from 'framer-motion'
import type { Card as CardData } from '../../../shared/types'
import { useArtworkGradient } from './useArtworkGradient'
import { CardBody } from './CardBody'
import { ArrowGlyph } from './icons'

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
  /** A plain (non-drag) click on the card — left mouse button discards, right mouse button keeps. */
  onCardClick: (button: 'left' | 'right') => void
  /** Set when this mount is an undo restoring the card — it re-enters from the side it left. */
  enterFromExitDirection?: 'keep' | 'discard' | null
  /** Only meaningful (and only rendered) for the true interactive front card. */
  isPlaying: boolean
  onTogglePlay?: () => void
}

function exitDurationMs(velocity: number, reducedMotion: boolean): number {
  if (reducedMotion) return REDUCED_MOTION_DURATION_MS
  const fromVelocity = 90000 / Math.max(Math.abs(velocity), 200)
  return Math.min(EXIT_DURATION_MAX_MS, Math.max(EXIT_DURATION_MIN_MS, fromVelocity))
}

export const SwipeCard = forwardRef<SwipeCardHandle, Props>(function SwipeCard(
  {
    card,
    stackIndex,
    reducedMotion,
    onCommitted,
    onExitAnimationComplete,
    onCardClick,
    enterFromExitDirection,
    isPlaying,
    onTogglePlay
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { gradient: artworkGradient, aspectRatio, borderColor } = useArtworkGradient(card.artDataUrl)
  const x = useMotionValue(enterFromExitDirection ? (enterFromExitDirection === 'keep' ? 480 : -480) : 0)
  // Cards behind the front one are fully hidden — no fanned "peek" of their edges, which is what
  // let a taller upcoming card visibly stick out past the (shorter) front card's bounds. A card
  // only becomes visible the instant it's promoted to front (stackIndex reaches 0), fading in
  // while the outgoing front card's own exit animation plays over it.
  const opacity = useMotionValue(stackIndex === 0 || enterFromExitDirection ? 1 : 0)
  const rotate = useTransform(x, [-320, 320], reducedMotion ? [0, 0] : [-8, 8], { clamp: true })
  // §9.3: fades in beyond ~15% of card width, builds to full intensity near the 35% commit
  // threshold. The card's width is fixed by its `max-w-md` container (~448px) rather than
  // measured per-instance, so these are expressed as approximate pixel equivalents of that.
  const keepOpacity = useTransform(x, [67, 155], [0, 1], { clamp: true })
  const discardOpacity = useTransform(x, [-155, -67], [1, 0], { clamp: true })

  const pointerDown = useRef<{ x: number; y: number; t: number; button: number } | null>(null)

  // A card's own component instance persists across the transition from "stacked behind" to
  // "front" (see the merged single-.map() comment below), so this tracks whether *this instance*
  // has already been shown as front once, to fire the fade-in exactly once per promotion rather
  // than on every render once stackIndex reaches 0.
  const wasFront = useRef(stackIndex === 0 || !!enterFromExitDirection)
  useEffect(() => {
    if (stackIndex === 0 && !wasFront.current) {
      wasFront.current = true
      void animate(opacity, 1, { duration: reducedMotion ? 0.1 : 0.28 })
    } else if (stackIndex > 0) {
      wasFront.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackIndex])

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
    pointerDown.current = { x: e.clientX, y: e.clientY, t: Date.now(), button: e.button }
  }

  // Only two ways to interact with a card: drag it, or a plain (non-drag) click — left mouse
  // button discards, right mouse button keeps. No more zone-based thirds/center-click.
  function handlePointerUp(e: React.PointerEvent): void {
    const start = pointerDown.current
    pointerDown.current = null
    if (!start || !isFront) return

    const dx = Math.abs(e.clientX - start.x)
    const dy = Math.abs(e.clientY - start.y)
    const dt = Date.now() - start.t
    if (dx > 5 || dy > 5 || dt > 250) return // a drag that snaps back is not a click

    if (start.button === 0) onCardClick('left')
    else if (start.button === 2) onCardClick('right')
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
      // `inset-x-0 top-0` rather than `inset-0`: no `bottom`, so height is intrinsic (driven by
      // CardBody's own aspect-ratio artwork box + natural text content) instead of stretched to
      // match the stack container. The container itself gets its height from SwipeScreen's
      // invisible sizer clone of the *front* card — see the comment there. Stacked-behind cards
      // may therefore be a few px taller/shorter than that; harmless, since they're layered
      // behind the (opaque) front card and mostly hidden regardless.
      className="absolute inset-x-0 top-0 flex flex-col overflow-hidden rounded-2xl border shadow-xl"
      style={{
        x: usesDragPosition ? x : 0,
        rotate: usesDragPosition ? rotate : 0,
        opacity,
        // Plain — CardBody's artwork box and text panel between them exactly cover this root's
        // whole content area (no gaps), so anything painted here is never actually visible. The
        // artwork-derived gradient is painted directly on the text panel instead, which is the
        // only place it can be seen at all.
        background: 'var(--surface-raised)',
        borderColor: borderColor ?? 'var(--border-subtle)',
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
      onContextMenu={(e) => e.preventDefault()}
      data-testid="swipe-card"
    >
      {isFront && (
        <>
          {/* Drag-direction hints: fade in with the same colored panels as the drag progresses,
              per §9.3's intent-feedback thresholds — a text label + arrow, not just a color wash. */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-1/3 items-center justify-end pr-4"
            style={{ opacity: keepOpacity, background: 'linear-gradient(to left, var(--keep), transparent)' }}
          >
            <span className="flex items-center gap-1 text-sm font-semibold text-white">
              Keep <ArrowGlyph direction="right" />
            </span>
          </motion.div>
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-1/3 items-center justify-start pl-4"
            style={{ opacity: discardOpacity, background: 'linear-gradient(to right, var(--discard), transparent)' }}
          >
            <span className="flex items-center gap-1 text-sm font-semibold text-white">
              <ArrowGlyph direction="left" /> Discard
            </span>
          </motion.div>
        </>
      )}

      <CardBody
        card={card}
        artworkGradient={artworkGradient}
        aspectRatio={aspectRatio}
        isFront={isFront}
        isPlaying={isPlaying}
        onTogglePlay={onTogglePlay}
      />
    </motion.div>
  )
})
