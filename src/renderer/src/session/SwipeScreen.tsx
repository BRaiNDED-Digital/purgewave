import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMotionValue, useTransform, motion } from 'framer-motion'
import { SwipeCard } from './SwipeCard'
import { CardBody } from './CardBody'
import { useArtworkGradient } from './useArtworkGradient'
import { resolveKeyIntent, isUndoMouseButton } from './keymap'
import { useAudioEngine } from './useAudioEngine'
import { SettingsScreen } from './SettingsScreen'
import { GearIcon, KeyCap, ArrowGlyph, StopIcon, UndoIcon } from './icons'
import type { Card, DecisionEntry, SessionLimit, TrackDecision } from '../../../shared/types'

const PREFETCH_WINDOW = 50
const PREFETCH_LOOKAHEAD = 10
const UNDO_STACK_DEPTH = 20

interface UndoEntry {
  id: string
  direction: 'keep' | 'discard'
  previousEntry: DecisionEntry | null
}

export interface SessionSummary {
  kept: number
  marked: number
  reviewed: number
  keptIds: string[]
}

interface Props {
  queue: string[]
  limit: SessionLimit
  onEndSession: (summary: SessionSummary) => void
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (): void => setReduced(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return reduced
}

export function SwipeScreen({ queue, limit, onEndSession }: Props) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [windowEnd, setWindowEnd] = useState(0)
  const [cards, setCards] = useState<Map<string, Card>>(new Map())
  const [exiting, setExiting] = useState<Array<{ id: string; direction: 'keep' | 'discard' }>>([])
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [lastUndone, setLastUndone] = useState<{ id: string; direction: 'keep' | 'discard' } | null>(null)
  const [keptIds, setKeptIds] = useState<string[]>([])
  const [marked, setMarked] = useState(0)
  const kept = keptIds.length
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [autoplay, setAutoplay] = useState(true)
  const [normalize, setNormalize] = useState(true)
  const [volume, setVolume] = useState(0.8)
  const [previewStartRatio, setPreviewStartRatio] = useState(0.2)
  const settingsLoaded = useRef(false)

  const reducedMotion = useReducedMotion()
  const ended = currentIndex >= queue.length

  // Settings (§8) are persisted in main via settings.json — load once, then persist changes
  // made from this screen (volume nudges, etc.) back out. Skips the initial load's own echo.
  // previewStartRatio has no in-session control (only Settings screen edits it, which isn't
  // reachable mid-session), so it's loaded here but never written back from this component.
  useEffect(() => {
    window.purgewave.getSettings().then((s) => {
      setAutoplay(s.autoplay)
      setNormalize(s.normalizeVolume)
      setVolume(s.volume)
      setPreviewStartRatio(s.previewStartRatio)
      settingsLoaded.current = true
    })
  }, [])
  useEffect(() => {
    if (settingsLoaded.current) window.purgewave.updateSettings({ autoplay })
  }, [autoplay])
  useEffect(() => {
    if (settingsLoaded.current) window.purgewave.updateSettings({ normalizeVolume: normalize })
  }, [normalize])
  useEffect(() => {
    if (settingsLoaded.current) window.purgewave.updateSettings({ volume })
  }, [volume])

  // The embedded Settings modal (below) is the real SettingsScreen and writes straight to
  // settings.json via its own IPC calls — it doesn't share this component's local state, so
  // closing it re-reads whatever changed (autoplay/normalize/volume) back into the values this
  // screen's own audio engine actually uses.
  const closeSettings = useCallback(() => {
    setShowSettings(false)
    window.purgewave.getSettings().then((s) => {
      setAutoplay(s.autoplay)
      setNormalize(s.normalizeVolume)
      setVolume(s.volume)
    })
  }, [])

  const frontCard = cards.get(queue[currentIndex]) ?? null
  const nextCard = cards.get(queue[currentIndex + 1]) ?? null
  const audio = useAudioEngine(frontCard, nextCard, { autoplay, volume, normalize, previewStartRatio })
  // Every visible SwipeCard is `position: absolute` (so exit/stack animations don't disturb
  // layout), which means none of them can establish this container's height on their own — an
  // absolutely positioned box with no `bottom` sizes intrinsically, but its *parent* still needs
  // a real height for that to resolve against. This invisible, normal-flow clone of the front
  // card's content is that height reference; it's never seen, only measured by the browser's own
  // layout engine.
  const sizerVisuals = useArtworkGradient(frontCard?.artDataUrl ?? null)

  // Windowed prefetch (§3.7 rule 2): keep the current window plus the next one loaded, never
  // the whole queue — a 200k-track session would freeze on structured-clone otherwise.
  useEffect(() => {
    if (ended) return
    if (currentIndex + PREFETCH_LOOKAHEAD <= windowEnd) return
    if (windowEnd >= queue.length) return
    const nextEnd = Math.min(windowEnd + PREFETCH_WINDOW, queue.length)
    const idsToFetch = queue.slice(windowEnd, nextEnd)
    let cancelled = false
    // Only commit (cards + the watermark advance) once the fetch actually resolves — advancing
    // the watermark synchronously up front would make React 19 StrictMode's dev-only double
    // effect invocation drop the real fetch (its own cleanup marks it cancelled, and the second
    // invocation would then see the watermark already advanced and skip fetching entirely).
    window.purgewave.getCards(idsToFetch).then((fetched) => {
      if (cancelled) return
      setCards((prev) => {
        const next = new Map(prev)
        for (const c of fetched) next.set(c.id, c)
        return next
      })
      setWindowEnd(nextEnd)
    })
    return () => {
      cancelled = true
    }
  }, [currentIndex, windowEnd, queue, ended])

  const commit = useCallback(
    (id: string, direction: 'keep' | 'discard') => {
      const card = cards.get(id)
      const previousEntry: DecisionEntry | null = card?.pastReview
        ? { s: 'keep', r: card.pastReview.lastReviewedAt, n: card.pastReview.reviewCount }
        : null

      const decision: TrackDecision = direction === 'keep' ? 'keep' : 'delete'
      window.purgewave.decide(id, decision) // fire-and-forget — never awaited in the swipe path

      setUndoStack((s) => [...s.slice(-(UNDO_STACK_DEPTH - 1)), { id, direction, previousEntry }])
      setExiting((e) => [...e, { id, direction }])
      setCurrentIndex((i) => i + 1)
      if (direction === 'keep') setKeptIds((k) => [...k, id])
      else setMarked((m) => m + 1)
    },
    [cards]
  )

  // React 19 StrictMode double-invokes state-updater functions in dev to catch impurities, so
  // `undo`'s side effects (the IPC call, the other setState calls) must not live inside a
  // setUndoStack updater — that pattern silently ran everything twice. Reading the current
  // stack from a ref keeps `undo` itself stable (empty deps) without a stale closure.
  const undoStackRef = useRef<UndoEntry[]>([])
  useEffect(() => {
    undoStackRef.current = undoStack
  }, [undoStack])

  const undo = useCallback(() => {
    const stack = undoStackRef.current
    if (stack.length === 0) return
    const last = stack[stack.length - 1]
    window.purgewave.undo(last.id, last.previousEntry)
    setUndoStack(stack.slice(0, -1))
    setExiting((e) => e.filter((x) => x.id !== last.id))
    setCurrentIndex((i) => Math.max(0, i - 1))
    if (last.direction === 'keep') setKeptIds((k) => k.filter((id) => id !== last.id))
    else setMarked((m) => Math.max(0, m - 1))
    setLastUndone({ id: last.id, direction: last.direction })
  }, [])

  // Per user feedback there's no separate in-between "Session complete" screen anymore — clicking
  // End Session goes straight into the real summary (ReviewScreen, via onEndSession), which now
  // shows this session's own kept/purged/reviewed counts at its own top instead of repeating them
  // on an intermediate screen first. Naturally exhausting the queue finalizes the same way, via the
  // effect below — both paths call this exact same logic so they can't drift apart.
  const finalizeSession = useCallback(() => {
    window.purgewave.sessionComplete()
    onEndSession({ kept, marked, reviewed: currentIndex, keptIds })
  }, [onEndSession, kept, marked, currentIndex, keptIds])

  // Fires once the queue naturally runs out (not via the button above, which calls
  // `finalizeSession` directly instead) — same finalize logic either way.
  useEffect(() => {
    if (ended) finalizeSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended])

  // Keyboard + mouse-button-4 dispatch, per §6.4. Scoped to this screen only.
  const frontIdRef = useRef<string | undefined>(queue[currentIndex])
  frontIdRef.current = queue[currentIndex]
  const cardRefs = useRef(new Map<string, { exit: (d: 'keep' | 'discard') => void }>())

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.repeat) return
      const intent = resolveKeyIntent(e)
      if (!intent) return
      e.preventDefault()

      if (intent === 'help') return setShowHelp((v) => !v)
      // Nothing else fires while the help or settings overlay is open — Escape/`?` just close it.
      if (showHelp) {
        if (intent === 'endSession') setShowHelp(false)
        return
      }
      if (showSettings) {
        if (intent === 'endSession') closeSettings()
        return
      }

      if (intent === 'undo') return undo()
      if (intent === 'endSession') return finalizeSession()
      if (intent === 'playPause') return audio.togglePlayPause()
      if (intent === 'replay') return audio.replay()
      if (intent === 'volumeUp') return setVolume((v) => Math.min(1, Math.round((v + 0.1) * 100) / 100))
      if (intent === 'volumeDown') return setVolume((v) => Math.max(0, Math.round((v - 0.1) * 100) / 100))
      if (intent === 'discard' || intent === 'keep') {
        const id = frontIdRef.current
        if (!id) return
        cardRefs.current.get(id)?.exit(intent === 'keep' ? 'keep' : 'discard')
      }
    }
    function onMouseUp(e: MouseEvent): void {
      if (isUndoMouseButton(e)) undo()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [undo, finalizeSession, audio, showHelp, showSettings, closeSettings])

  // Static, window-level drag-intent hints (§9.3 revision): these no longer move with the card —
  // the card slides *over* them instead. Driven by the current front card's live drag state,
  // mirrored up here via SwipeCard's onDragChange (only the true front card ever reports).
  const dragX = useMotionValue(0)
  const handleDragChange = useCallback((x: number) => dragX.set(x), [dragX])
  // Always at least AMBIENT_OPACITY visible (a constant, ambient hint rather than something that
  // only appears on interaction) — but per user feedback, pressing the card without moving it
  // must NOT intensify these beyond that floor; only actual movement (dragX) should ramp them up,
  // so `dragPressed` no longer feeds into this at all.
  const AMBIENT_OPACITY = 0.22
  const keepHintOpacity = useTransform(dragX, (xv) => Math.max(AMBIENT_OPACITY, Math.min(1, Math.max(0, xv) / 155)))
  const discardHintOpacity = useTransform(dragX, (xv) => Math.max(AMBIENT_OPACITY, Math.min(1, Math.max(0, -xv) / 155)))

  const stackIds = useMemo(() => queue.slice(currentIndex, currentIndex + 3), [queue, currentIndex])

  // No more in-between "Session complete" screen here — the effect above already calls
  // `finalizeSession()` the instant `ended` becomes true, which hands off to the real summary
  // (ReviewScreen) via `onEndSession`. This still renders one blank frame in between (React commits
  // this render before the effect's `setView` in the parent takes effect) — `null` rather than the
  // old full-screen card avoids that frame looking like a broken/empty card stack.
  if (ended) return null

  const remainingCount = queue.length - currentIndex

  return (
    <div className="flex flex-1 flex-col items-center gap-4 p-6">
      {/* Static, window-level drag-intent hints (§9.3 revision) — `fixed inset-0`, so these span
          the FULL HEIGHT of the window and sit flush against its outer left/right edges, not just
          the card's own bounds. The 3-column flex row (hint / spacer / hint) is what centers the
          TEXT halfway between the card and the window edge without a manual calc(): the center
          spacer matches the card column's own `max-w-md`, and both hint columns are equal `flex-1`
          gutters, so flexbox's own centering lands the text in the middle of each gutter for free.
          The COLOR wash is a separate, narrower band pinned to the true outer edge (not spanning
          the whole gutter) — per user feedback, the color needs to stay close to the window edge
          rather than visually reaching all the way to the card. Rendered as an early sibling
          (painted first) so the card stack, later in DOM order, always slides visually *over*
          these rather than under them. */}
      <div className="pointer-events-none fixed inset-0 z-0 flex items-stretch">
        <div className="relative flex flex-1 items-center justify-center">
          <motion.div
            aria-hidden
            className="absolute inset-y-0 left-0 w-56"
            style={{
              opacity: discardHintOpacity,
              background: 'linear-gradient(to left, transparent, color-mix(in srgb, var(--discard) 45%, transparent))'
            }}
          />
          {/* One row now: the arrow — bigger, vertically centered with the label via `items-center`
              — is the OUTERMOST element (leftmost, closest to the window edge), pointing further
              outward; the A keycap sits on the INNER side (rightmost, toward the card), with the
              all-caps label in between. */}
          <div
            className="relative z-10 flex items-center gap-2 text-xl font-bold uppercase"
            style={{ color: 'color-mix(in srgb, var(--discard) 70%, white)' }}
          >
            <ArrowGlyph direction="left" size={26} />
            <span>Purge</span>
            <KeyCap label="A" color="var(--discard)" />
          </div>
        </div>
        <div className="w-full max-w-md shrink-0" aria-hidden />
        <div className="relative flex flex-1 items-center justify-center">
          <motion.div
            aria-hidden
            className="absolute inset-y-0 right-0 w-56"
            style={{
              opacity: keepHintOpacity,
              background: 'linear-gradient(to right, transparent, color-mix(in srgb, var(--keep) 45%, transparent))'
            }}
          />
          <div
            className="relative z-10 flex items-center gap-2 text-xl font-bold uppercase"
            style={{ color: 'color-mix(in srgb, var(--keep) 70%, white)' }}
          >
            <KeyCap label="D" color="var(--keep)" />
            <span>Keep</span>
            <ArrowGlyph direction="right" size={26} />
          </div>
        </div>
      </div>

      {/* This wrapper soaks up all the leftover vertical space so the heading+card sit centered
          in the window together, as one unit, with breathing room above (controls) and below
          (action buttons) — the heading is no longer a separate row pinned near the top; it's
          part of this centered column, sitting directly above the card. No overflow-hidden here
          on purpose — the card-stack container below is exactly card-sized, so clipping at this
          level cuts the exit animation off right at the card's own edge instead of letting it
          visually slide and fade across the viewport. The scrollbar this used to cause (a card
          mid-exit translates ~1.4x viewport width past this container's bounds) is handled once,
          globally, via `overflow-x: hidden` on body in styles.css instead — that clips only at
          the true document edge, not the card's local bounding box. */}
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-3">
        {/* Progress + tally: the "N left" count is the big headline (its own line), kept/purged
            are smaller color-coded subheadings underneath rather than folded into one sentence. */}
        <div className="flex w-full max-w-md flex-col items-center gap-0.5">
          <span className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {limit ? `${remainingCount} left in this session` : `${currentIndex + 1} of ${queue.length}`}
          </span>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span style={{ color: 'var(--discard)' }}>{marked} Purged</span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ color: 'var(--keep)' }}>{kept} Kept</span>
          </div>
        </div>

        <div className="relative z-10 w-full max-w-md">
          {/* Invisible sizer (see the comment above `sizerVisuals`): normal-flow, so it gives
              this `relative` container a real height equal to the front card's own natural
              content height — square artwork, a tall cover, a card with extra optional lines of
              metadata all grow or shrink this the same way they'd grow or shrink the real card. */}
          {frontCard && (
            <div className="invisible flex flex-col overflow-hidden rounded-2xl border-2" aria-hidden="true">
              <CardBody
                card={frontCard}
                artworkGradient={sizerVisuals.gradient}
                aspectRatio={sizerVisuals.aspectRatio}
                isFront={false}
                isPlaying={false}
              />
            </div>
          )}
          {/*
           * Stack cards and exiting cards are merged into ONE array and mapped in a single pass —
           * not two separate `{a.map()}{b.map()}` expressions — because React reconciles each
           * `{array.map(...)}` JSX expression as its own independent child-list keyed only within
           * itself. A card whose key moves from the "stack" expression to the "exiting" expression
           * across a render (even with an identical key value) does NOT get matched as the same
           * fiber: React unmounts it from the first list and mounts a brand new instance in the
           * second, discarding the in-flight drag/exit motion values. That produced the exact bug
           * this merge fixes — confirmed via CDP trace (mount/unmount logging), not just reasoning:
           * the committed card's SwipeCard instance actually unmounted and a fresh, static
           * (opacity 1, x 0, never animating) replacement mounted in its place, permanently
           * overlaying the newly-promoted front card. A single `.map()` over one combined array
           * keeps it as one reconciliation context, so the same fiber — and its live x/opacity
           * motion values mid-animation — survives the stack→exiting transition.
           */}
          {[
            ...stackIds
              .slice()
              .reverse()
              .map((id, revIdx) => ({ id, stackIndex: stackIds.length - 1 - revIdx, exiting: false as const })),
            ...exiting.map(({ id }) => ({ id, stackIndex: -1, exiting: true as const }))
          ].map(({ id, stackIndex, exiting: isExiting }) => {
            const card = cards.get(id)
            if (!card) return null
            return (
              <SwipeCard
                key={id}
                ref={(handle) => {
                  if (handle) cardRefs.current.set(id, handle)
                  else cardRefs.current.delete(id)
                }}
                card={card}
                stackIndex={stackIndex}
                reducedMotion={reducedMotion}
                enterFromExitDirection={!isExiting && lastUndone?.id === id ? lastUndone.direction : null}
                onCommitted={(direction) => commit(id, direction)}
                onExitAnimationComplete={() => setExiting((e) => e.filter((x) => x.id !== id))}
                isPlaying={!isExiting && stackIndex === 0 ? audio.isPlaying : false}
                onTogglePlay={!isExiting && stackIndex === 0 ? audio.togglePlayPause : undefined}
                currentTime={!isExiting && stackIndex === 0 ? audio.currentTime : undefined}
                volume={!isExiting && stackIndex === 0 ? volume : undefined}
                onVolumeChange={!isExiting && stackIndex === 0 ? setVolume : undefined}
                onDragChange={!isExiting && stackIndex === 0 ? handleDragChange : undefined}
              />
            )
          })}
        </div>
      </div>

      {/* A/D purge/keep glyphs now live up in the drag-intent hint panels (always visible against
          the window edges), so this row is just the three remaining session controls: End Session
          and Settings, moved down from their old top-row spot to flank Undo — now a real icon
          button instead of a Z-keycap-plus-label pair. */}
      <div className="flex w-full max-w-md items-center justify-between">
        <button
          onClick={finalizeSession}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium"
          style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
        >
          <StopIcon size={12} /> End Session
        </button>
        <button
          onClick={undo}
          disabled={undoStack.length === 0}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <UndoIcon size={14} /> Undo
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <GearIcon size={14} /> Settings
        </button>
      </div>

      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ backgroundColor: 'color-mix(in srgb, var(--surface-base) 60%, transparent)' }}
          onClick={() => setShowHelp(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border p-5 shadow-xl"
            style={{ backgroundColor: 'var(--surface-overlay)', borderColor: 'var(--border-subtle)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Keyboard shortcuts
            </h3>
            <dl className="flex flex-col gap-2 text-sm">
              {[
                ['Purge', 'A · Delete · drag left'],
                ['Keep', 'D · Enter · drag right'],
                ['Play / pause', 'Space · play button on card'],
                ['Replay from start', 'R'],
                ['Undo', 'Ctrl+Z · Backspace · U · mouse back button'],
                ['End Session', 'Esc'],
                ['Volume', '+ / −'],
                ['This list', '?']
              ].map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <dt style={{ color: 'var(--text-primary)' }}>{label}</dt>
                  <dd className="text-right" style={{ color: 'var(--text-muted)' }}>
                    {keys}
                  </dd>
                </div>
              ))}
            </dl>
            <button
              onClick={() => setShowHelp(false)}
              className="mt-4 w-full rounded-xl border py-2 text-sm font-medium"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ backgroundColor: 'color-mix(in srgb, var(--surface-base) 60%, transparent)' }}
          onClick={closeSettings}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border shadow-xl"
            style={{ backgroundColor: 'var(--surface-overlay)', borderColor: 'var(--border-subtle)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <SettingsScreen onDone={closeSettings} />
          </div>
        </div>
      )}
    </div>
  )
}
