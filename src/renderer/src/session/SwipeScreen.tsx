import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SwipeCard } from './SwipeCard'
import { resolveKeyIntent, isUndoMouseButton } from './keymap'
import { useAudioEngine } from './useAudioEngine'
import type { Card, DecisionEntry, SessionLimit, TrackDecision } from '../../../shared/types'

const PREFETCH_WINDOW = 50
const PREFETCH_LOOKAHEAD = 10
const UNDO_STACK_DEPTH = 20
const HINT_KEY = 'purgewave.hintDismissed'

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
  const [hintDismissed, setHintDismissed] = useState(() => localStorage.getItem(HINT_KEY) === '1')
  const [showHelp, setShowHelp] = useState(false)
  const [autoplay, setAutoplay] = useState(true)
  const [normalize, setNormalize] = useState(true)
  const [volume, setVolume] = useState(0.8)
  const [sideClickDecisions, setSideClickDecisions] = useState(true)
  const settingsLoaded = useRef(false)

  const reducedMotion = useReducedMotion()
  const ended = currentIndex >= queue.length

  // Settings (§8) are persisted in main via settings.json — load once, then persist changes
  // made from this screen (volume nudges, etc.) back out. Skips the initial load's own echo.
  useEffect(() => {
    window.purgewave.getSettings().then((s) => {
      setAutoplay(s.autoplay)
      setNormalize(s.normalizeVolume)
      setVolume(s.volume)
      setSideClickDecisions(s.sideClickDecisions)
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

  const frontCard = cards.get(queue[currentIndex]) ?? null
  const nextCard = cards.get(queue[currentIndex + 1]) ?? null
  const audio = useAudioEngine(frontCard, nextCard, { autoplay, volume, normalize })

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

  const endSession = useCallback(() => {
    window.purgewave.sessionComplete()
    onEndSession({ kept, marked, reviewed: currentIndex, keptIds })
  }, [onEndSession, kept, marked, currentIndex, keptIds])

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
      // Nothing else fires while the help overlay is open, per §6.4 — Escape/`?` just close it.
      if (showHelp) {
        if (intent === 'endSession') setShowHelp(false)
        return
      }

      if (intent === 'undo') return undo()
      if (intent === 'endSession') return endSession()
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
  }, [undo, endSession, audio, showHelp])

  function handleZoneClick(zone: 'left' | 'center' | 'right'): void {
    const id = frontIdRef.current
    if (!id) return
    // §8 "Side-click decisions": off leaves the whole card as play/pause only.
    if (!sideClickDecisions || zone === 'center') return audio.togglePlayPause()
    if (zone === 'left') cardRefs.current.get(id)?.exit('discard')
    else cardRefs.current.get(id)?.exit('keep')
  }

  function dismissHint(): void {
    localStorage.setItem(HINT_KEY, '1')
    setHintDismissed(true)
  }

  const stackIds = useMemo(() => queue.slice(currentIndex, currentIndex + 3), [queue, currentIndex])

  if (ended) {
    const isEmpty = queue.length === 0
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          {isEmpty ? 'Nothing to review' : 'Session complete'}
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          {isEmpty
            ? "Your library is fully triaged — there's nothing left in the queue right now."
            : `${kept} kept · ${marked} marked for deletion · ${currentIndex} reviewed`}
        </p>
        <button
          onClick={() => {
            window.purgewave.sessionComplete()
            onEndSession({ kept, marked, reviewed: currentIndex, keptIds })
          }}
          className="mt-4 rounded-xl border px-6 py-3 font-medium"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          Done
        </button>
      </div>
    )
  }

  const remainingCount = queue.length - currentIndex

  return (
    <div className="flex flex-1 flex-col items-center gap-4 p-6">
      <div className="flex w-full max-w-md items-center justify-between text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>
          {limit ? `${remainingCount} left in this session` : `${currentIndex + 1} of ${queue.length}`}
        </span>
        <span>
          {kept} kept · {marked} marked
        </span>
      </div>

      <div className="flex w-full max-w-md items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} />
          Autoplay
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          Normalize volume
        </label>
        <label className="flex items-center gap-1.5">
          Volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
      </div>

      {!hintDismissed && (
        <div
          className="flex w-full max-w-md items-center justify-between rounded-lg border px-4 py-2 text-xs"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <span>← discard · → keep · Ctrl+Z / Backspace undo · Esc end session · ? for all shortcuts</span>
          <button onClick={dismissHint} aria-label="Dismiss hint" style={{ color: 'var(--text-muted)' }}>
            ✕
          </button>
        </div>
      )}

      <div className="relative h-[520px] w-full max-w-md">
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
              onZoneClick={isExiting ? () => {} : handleZoneClick}
            />
          )
        })}
      </div>

      <div className="flex w-full max-w-md items-center justify-between">
        <button
          onClick={() => handleZoneClick('left')}
          className="rounded-xl border px-5 py-3 font-medium"
          style={{ borderColor: 'var(--discard)', color: 'var(--discard)' }}
        >
          Discard
        </button>
        <button
          onClick={undo}
          disabled={undoStack.length === 0}
          className="rounded-xl border px-4 py-3 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          Undo
        </button>
        <button onClick={endSession} className="text-sm underline" style={{ color: 'var(--text-muted)' }}>
          End session
        </button>
        <button
          onClick={() => setShowHelp(true)}
          aria-label="Keyboard shortcuts"
          className="rounded-full border text-sm font-medium"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', width: 28, height: 28 }}
        >
          ?
        </button>
        <button
          onClick={() => handleZoneClick('right')}
          className="rounded-xl border px-5 py-3 font-medium"
          style={{ borderColor: 'var(--keep)', color: 'var(--keep)' }}
        >
          Keep
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
                ['Discard', '← · A · Delete · click left third'],
                ['Keep', '→ · D · Enter · click right third'],
                ['Play / pause', 'Space · click center third'],
                ['Replay from start', '↑ · R'],
                ['Undo', 'Ctrl+Z · Backspace · U · mouse back button'],
                ['End session', 'Esc'],
                ['Volume', '+ / − · scroll over volume'],
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
    </div>
  )
}
