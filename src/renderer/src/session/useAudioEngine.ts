import { useEffect, useRef, useState } from 'react'
import type { Card } from '../../../shared/types'

const FADE_IN_MS = 1000
const FADE_OUT_MS = 200
const SLOW_PREPARE_MS = 400
const TARGET_LOUDNESS_DB = -18
const MAX_CORRECTION_DB = 12

interface Slot {
  el: HTMLAudioElement
  source: MediaElementAudioSourceNode
  gain: GainNode
  preparedFor: string | null
  seekFailed: boolean
}

export interface AudioEngineSettings {
  autoplay: boolean
  volume: number // 0..1
  normalize: boolean
  previewStartRatio: number // 0..1, how far into the track playback begins (§8 setting)
}

export interface AudioEngineHandle {
  togglePlayPause: () => void
  replay: () => void
  isPlaying: boolean
}

function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

// Tracks that timed out preparing from the configured start offset once fall back to offset 0
// on every subsequent play, per §3.7 rule 4 ("a fast start from the beginning beats a slow start from
// the middle") — session-scoped, deliberately not persisted.
const slowStartTracks = new Set<string>()

/**
 * Two <audio> elements ping-ponged (§3.7 rule 3): while the front card plays on the active
 * element, the next card is already loaded and seeked on the other, muted and paused, so
 * advancing never waits on a load. Each element gets its own GainNode for independent fades
 * and per-track loudness normalization (§6.5).
 */
export function useAudioEngine(
  frontCard: Card | null,
  nextCard: Card | null,
  settings: AudioEngineSettings
): AudioEngineHandle {
  const ctxRef = useRef<AudioContext | null>(null)
  const slotsRef = useRef<[Slot, Slot] | null>(null)
  // Which slot is actually audible right now — updated only once the real fade/play happens,
  // so playback controls (toggle/replay/volume) always act on what's truly making sound.
  const activeIndexRef = useRef(0)
  // Which slot is *assigned* to the current front card — committed synchronously, before any
  // await, so the sibling nextCard-prefetch effect (which can run in the same commit, before
  // any microtask drains) always computes the correct standby slot. See the race this fixes,
  // documented above the `activate` effect below.
  const assignedIndexRef = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Reflects whichever slot is currently active, for the card's play/pause button — updated by
  // each slot's own play/pause/ended listeners, filtered to only the slot activeIndexRef points
  // at right now, so the *outgoing* element's pause() call (fired 200ms into every crossfade)
  // never clobbers this back to false right after the *incoming* element already started.
  const [isPlaying, setIsPlaying] = useState(false)

  function ensureEngine(): [Slot, Slot] {
    if (slotsRef.current) return slotsRef.current
    const ctx = new AudioContext()
    ctxRef.current = ctx
    const makeSlot = (): Slot => {
      const el = new Audio()
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      const source = ctx.createMediaElementSource(el)
      const gain = ctx.createGain()
      gain.gain.value = 0
      source.connect(gain).connect(ctx.destination)
      const slot: Slot = { el, source, gain, preparedFor: null, seekFailed: false }
      const isActiveSlot = (): boolean => slotsRef.current?.[activeIndexRef.current] === slot
      el.addEventListener('play', () => {
        if (isActiveSlot()) setIsPlaying(true)
      })
      el.addEventListener('pause', () => {
        if (isActiveSlot()) setIsPlaying(false)
      })
      el.addEventListener('ended', () => {
        if (isActiveSlot()) setIsPlaying(false)
      })
      return slot
    }
    const slots: [Slot, Slot] = [makeSlot(), makeSlot()]
    slotsRef.current = slots
    return slots
  }

  async function measureAndApplyGain(slot: Slot, card: Card, baseGain: number): Promise<void> {
    if (!settingsRef.current.normalize || card.replayGainDb !== null) return
    const ctx = ctxRef.current
    if (!ctx) return

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    slot.source.connect(analyser)
    const buffer = new Float32Array(analyser.fftSize)

    await new Promise((resolve) => setTimeout(resolve, SLOW_PREPARE_MS))
    analyser.getFloatTimeDomainData(buffer)
    slot.source.disconnect(analyser)

    let sumSquares = 0
    for (const sample of buffer) sumSquares += sample * sample
    const rms = Math.sqrt(sumSquares / buffer.length)
    if (rms <= 0) return

    const measuredDb = 20 * Math.log10(rms)
    const correctionDb = Math.max(-MAX_CORRECTION_DB, Math.min(MAX_CORRECTION_DB, TARGET_LOUDNESS_DB - measuredDb))

    const now = ctx.currentTime
    slot.gain.gain.cancelScheduledValues(now)
    slot.gain.gain.linearRampToValueAtTime(baseGain * dbToGain(correctionDb), now + (FADE_IN_MS / 1000) * 0.4)

    window.purgewave.cacheGain(card.id, correctionDb)
  }

  async function prepare(slot: Slot, card: Card): Promise<void> {
    if (slot.preparedFor === card.id) return
    slot.preparedFor = card.id
    slot.seekFailed = false

    if (card.previewUnsupported) return

    slot.el.src = window.purgewave.trackUrl(card.id)
    slot.el.muted = true
    slot.el.volume = 1

    const offsetSec = slowStartTracks.has(card.id) ? 0 : card.durationSec * settingsRef.current.previewStartRatio

    await new Promise<void>((resolve) => {
      const onLoaded = (): void => {
        slot.el.removeEventListener('loadedmetadata', onLoaded)
        resolve()
      }
      const onError = (): void => {
        slot.el.removeEventListener('error', onError)
        resolve()
      }
      slot.el.addEventListener('loadedmetadata', onLoaded, { once: true })
      slot.el.addEventListener('error', onError, { once: true })
    })

    const prepareStarted = performance.now()
    if (offsetSec > 0) {
      slot.el.currentTime = offsetSec
      await new Promise<void>((resolve) => {
        const onSeeked = (): void => {
          slot.el.removeEventListener('seeked', onSeeked)
          resolve()
        }
        slot.el.addEventListener('seeked', onSeeked, { once: true })
        setTimeout(resolve, SLOW_PREPARE_MS) // don't hang forever if seeking never lands
      })
      if (slot.el.seekable.length === 0 || Math.abs(slot.el.currentTime - offsetSec) > 1) {
        slot.seekFailed = true
        slowStartTracks.add(card.id)
      }
    }
    if (performance.now() - prepareStarted > SLOW_PREPARE_MS) {
      slowStartTracks.add(card.id)
    }
  }

  function fadeGain(slot: Slot, target: number, ms: number): void {
    const ctx = ctxRef.current
    if (!ctx) return
    const now = ctx.currentTime
    slot.gain.gain.cancelScheduledValues(now)
    slot.gain.gain.setValueAtTime(slot.gain.gain.value, now)
    slot.gain.gain.linearRampToValueAtTime(target, now + ms / 1000)
  }

  useEffect(() => {
    if (!frontCard) return
    let cancelled = false

    const [a, b] = ensureEngine()
    // If the next-prepared standby slot already matches the new front card, ping-pong onto
    // it; otherwise (e.g. session just started) prepare the currently-active slot in place.
    // Race this avoids: the sibling nextCard-prefetch effect below can run synchronously right
    // after this one, in the same commit, before `activate`'s `await prepare(...)` below ever
    // yields — so it must see the slot this card is claiming *now*, not after the async work
    // completes. Committing `assignedIndexRef` synchronously here (before any await) is what
    // makes that possible; previously this assignment lived after the await, inside `activate`,
    // so the sibling effect read a stale index and prefetched the next track onto the very slot
    // this card was mid-activation on — audibly swapping to the wrong track's audio while the
    // correct card was still on screen.
    const standbyIndex = 1 - assignedIndexRef.current
    const standby = [a, b][standbyIndex]
    const useStandby = standby.preparedFor === frontCard.id
    const targetIndex = useStandby ? standbyIndex : assignedIndexRef.current
    assignedIndexRef.current = targetIndex

    async function activate(): Promise<void> {
      const outgoing = [a, b][1 - targetIndex]
      const incoming = [a, b][targetIndex]

      await prepare(incoming, frontCard!)
      if (cancelled) return

      // §6.5 "stop the outgoing track before starting the incoming one — never overlap": fade
      // the outgoing track out and *wait for that to finish* before the incoming track starts
      // playing, rather than starting both at once. Starting them simultaneously meant two
      // tracks were genuinely decoding and mixing at once for the full 200ms fade-out window on
      // every single swipe — real, audible double audio work at exactly the moment a drag is
      // most likely to be starting, not just a cosmetic spec deviation.
      if (outgoing !== incoming) {
        fadeGain(outgoing, 0, FADE_OUT_MS)
        await new Promise<void>((resolve) => setTimeout(resolve, FADE_OUT_MS))
        outgoing.el.pause()
        if (cancelled) return
      }

      activeIndexRef.current = targetIndex
      incoming.el.muted = false

      const baseGain = settingsRef.current.volume
      const gainAdjustDb = settingsRef.current.normalize && frontCard!.replayGainDb !== null ? frontCard!.replayGainDb : 0
      const target = baseGain * dbToGain(gainAdjustDb)

      if (!frontCard!.previewUnsupported && settingsRef.current.autoplay) {
        void incoming.el.play().catch(() => {})
        fadeGain(incoming, target, FADE_IN_MS)
        void measureAndApplyGain(incoming, frontCard!, baseGain)
      }
    }

    void activate()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontCard?.id])

  useEffect(() => {
    if (!nextCard) return
    const slots = slotsRef.current
    if (!slots) return
    // assignedIndexRef, not activeIndexRef — see the comment above the frontCard effect. This
    // must reflect which slot the *current* front card claimed, even before its own activation
    // has finished, or this can prefetch onto the slot that's still mid-activation.
    const standby = slots[1 - assignedIndexRef.current]
    void prepare(standby, nextCard)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCard?.id])

  // Live volume changes re-target the active element's gain (not a fade — an immediate but
  // click-free ramp), never the passive HTMLMediaElement.volume, which the GainNode replaces.
  useEffect(() => {
    const slots = slotsRef.current
    const card = frontCard
    if (!slots || !card || card.previewUnsupported) return
    const active = slots[activeIndexRef.current]
    const gainAdjustDb = settings.normalize && card.replayGainDb !== null ? card.replayGainDb : 0
    fadeGain(active, settings.volume * dbToGain(gainAdjustDb), 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.volume])

  // True unmount only (leaving the swipe screen entirely) — tears down the whole audio graph.
  useEffect(() => {
    return () => {
      const slots = slotsRef.current
      slots?.forEach((s) => s.el.pause())
      void ctxRef.current?.close()
    }
  }, [])

  return {
    togglePlayPause: () => {
      const slots = slotsRef.current
      if (!slots) return
      const active = slots[activeIndexRef.current]
      if (active.el.paused) void active.el.play().catch(() => {})
      else active.el.pause()
    },
    replay: () => {
      const slots = slotsRef.current
      if (!slots || !frontCard) return
      const active = slots[activeIndexRef.current]
      const offset = slowStartTracks.has(frontCard.id) ? 0 : frontCard.durationSec * settingsRef.current.previewStartRatio
      active.el.currentTime = offset
      void active.el.play().catch(() => {})
    },
    isPlaying
  }
}
