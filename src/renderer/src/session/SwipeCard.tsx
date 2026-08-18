import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { motion, useMotionValue, useTransform, animate, type PanInfo } from 'framer-motion'
import type { Card as CardData } from '../../../shared/types'
import { useArtworkGradient } from './useArtworkGradient'
import { CardBody } from './CardBody'

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
  /** Set when this mount is an undo restoring the card — it re-enters from the side it left. */
  enterFromExitDirection?: 'keep' | 'discard' | null
  /** Only meaningful (and only rendered) for the true interactive front card. */
  isPlaying: boolean
  onTogglePlay?: () => void
  volume?: number
  onVolumeChange?: (volume: number) => void
  currentTime?: number
  /** Only meaningful for the true interactive front card: reports live drag x (px) so the parent
   * can drive the static, window-level intent hints — these no longer live on the card itself
   * (see SwipeScreen). Only actual movement should feed those hints, so this reports x alone, not
   * pointer-held-down state. */
  onDragChange?: (x: number) => void
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
    enterFromExitDirection,
    isPlaying,
    onTogglePlay,
    volume,
    onVolumeChange,
    currentTime,
    onDragChange
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

  // Reports this card's live drag x to the parent while — and only while — it's the true
  // interactive front card. Reset to 0 on cleanup (front status lost, or unmount) so the parent's
  // static hints don't get stuck showing a stale mid-drag intensity from a card that's no longer
  // being dragged.
  useEffect(() => {
    if (stackIndex !== 0 || !onDragChange) return
    onDragChange(x.get())
    const unsubX = x.on('change', onDragChange)
    return () => {
      unsubX()
      onDragChange(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackIndex === 0])

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
      // Demoted back into the stack — this only happens via undo (a previous card re-entering
      // pushes this one from front back to stackIndex 1+). Without fading back out, this card's
      // opacity stayed stuck at 1 from when it was front, so repeated undos left every previously-
      // front card fully visible and stacked up behind the current one — the exact "peek past a
      // shorter front card's edges" bug the opacity-starts-at-0 invariant above exists to prevent,
      // just reached via a different path (undo demotion, not initial mount).
      if (wasFront.current) void animate(opacity, 0, { duration: reducedMotion ? 0.1 : 0.2 })
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
      //
      // No explicit z-index — this relies on plain DOM order (painted after SwipeScreen's static
      // intent-hint panels) so a dragged/exiting card visually slides *over* those static panels
      // rather than under them, per §9.3's revised design (the hints no longer move with the card).
      className="absolute inset-x-0 top-0"
      style={{
        x: usesDragPosition ? x : 0,
        rotate: usesDragPosition ? rotate : 0,
        opacity,
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
      onContextMenu={(e) => e.preventDefault()}
      data-testid="swipe-card"
    >
      <div
        className="flex flex-col overflow-hidden rounded-2xl border-2 shadow-xl"
        style={{ background: 'var(--surface-raised)', borderColor: borderColor ?? 'var(--border-subtle)' }}
      >
        <CardBody
          card={card}
          artworkGradient={artworkGradient}
          aspectRatio={aspectRatio}
          isFront={isFront}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
          volume={volume}
          onVolumeChange={onVolumeChange}
          currentTime={currentTime}
        />
      </div>
    </motion.div>
  )
})
