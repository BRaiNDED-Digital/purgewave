import { useEffect, useRef } from 'react'
import type { Card } from '../../../shared/types'

const START_OFFSET_RATIO = 0.2
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
}

export interface AudioEngineHandle {
  togglePlayPause: () => void
  replay: () => void
}

function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

// Tracks that timed out preparing from the 20% offset once fall back to offset 0 on every
// subsequent play, per §3.7 rule 4 ("a fast start from the beginning beats a slow start from
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
  const activeIndexRef = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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
      return { el, source, gain, preparedFor: null, seekFailed: false }
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

    const offsetSec = slowStartTracks.has(card.id) ? 0 : card.durationSec * START_OFFSET_RATIO

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

    async function activate(): Promise<void> {
      const [a, b] = ensureEngine()
      // If the next-prepared standby slot already matches the new front card, ping-pong onto
      // it; otherwise (e.g. session just started) prepare the currently-active slot in place.
      const standbyIndex = 1 - activeIndexRef.current
      const standby = [a, b][standbyIndex]
      const useStandby = standby.preparedFor === frontCard!.id
      const targetIndex = useStandby ? standbyIndex : activeIndexRef.current
      const outgoing = [a, b][1 - targetIndex]
      const incoming = [a, b][targetIndex]

      await prepare(incoming, frontCard!)
      if (cancelled) return

      if (outgoing !== incoming) {
        fadeGain(outgoing, 0, FADE_OUT_MS)
        setTimeout(() => outgoing.el.pause(), FADE_OUT_MS)
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
    const standby = slots[1 - activeIndexRef.current]
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
      const offset = slowStartTracks.has(frontCard.id) ? 0 : frontCard.durationSec * START_OFFSET_RATIO
      active.el.currentTime = offset
      void active.el.play().catch(() => {})
    }
  }
}
