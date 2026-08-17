import { useEffect, useRef, useState } from 'react'
import type { Card } from '../../../shared/types'

const FADE_IN_MS = 1000
const FADE_OUT_MS = 200
const SLOW_PREPARE_MS = 400
const TARGET_LOUDNESS_DB = -18
const MAX_CORRECTION_DB = 12
// A correction this close to the clamp is more likely a bad one-sample read (a quiet intro, a
// silent gap) than a track that's genuinely 11.5+ dB off target — real ReplayGain tags and sane
// measurements rarely land exactly at the edge of the allowed range. Treated as untrustworthy so
// it gets re-measured rather than trusted forever once cached; see `isTrustworthyCorrection`.
const SUSPICIOUS_CORRECTION_DB = MAX_CORRECTION_DB - 0.5
// How many RMS snapshots go into one measurement, and how far apart. The *preloaded* measurement
// (see `preloadNormalization`) runs silently, a full card ahead of when it's needed, so it can
// afford more samples spread further apart than the *fallback* one (`measureAndApplyGain`, which
// runs while the track is already audible) — more samples spread over more of the track is what
// actually protects against a single quiet passage skewing the result; one 400ms snapshot doesn't.
const FALLBACK_SAMPLE_COUNT = 5
const PRELOAD_SAMPLE_COUNT = 16
const GAIN_SAMPLE_INTERVAL_MS = 150

interface Slot {
  el: HTMLAudioElement
  source: MediaElementAudioSourceNode
  gain: GainNode
  analyser: AnalyserNode
  preparedFor: string | null
  seekFailed: boolean
  // Set by `preloadNormalization` once it has silently measured a *standby* (not-yet-audible)
  // track's loudness ahead of time, so `activate()` can apply the correction from the first
  // audible instant instead of starting at raw gain and only correcting a beat later. Null until
  // measured; cleared whenever the slot moves on to preparing a different track.
  pendingGainDb: number | null
  // The correction (dB) actually in effect on this slot right now — from a tag, a preload
  // measurement, or a post-hoc mid-playback measurement, whichever applied. Live volume changes
  // read this directly rather than recomputing from `card.replayGainDb`, which stays `null` in
  // the React `card` prop for the lifetime of this play (the measured value only reaches that
  // prop on a future `getCards()` refetch) — see the volume-slider effect below.
  appliedCorrectionDb: number
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
      // A Web Audio node that has no path to the destination is never actually processed by the
      // engine — an AnalyserNode connected only *from* the source (with nothing connected out of
      // it) silently sits idle and getFloatTimeDomainData() reads back zeros forever. Routing it
      // through its own silent (gain 0) node into the destination keeps it "live" in the render
      // graph without adding any audible signal. This was the reason RMS-based normalization for
      // untagged tracks never actually applied any correction — `rms <= 0` on every measurement,
      // so `measureAndApplyGain` returned early and no gain adjustment (or cached replayGainDb)
      // was ever produced.
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      const analyserSink = ctx.createGain()
      analyserSink.gain.value = 0
      source.connect(analyser).connect(analyserSink).connect(ctx.destination)
      const slot: Slot = {
        el,
        source,
        gain,
        analyser,
        preparedFor: null,
        seekFailed: false,
        pendingGainDb: null,
        appliedCorrectionDb: 0
      }
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

  // A cached value this close to the clamp boundary is treated as unproven rather than final —
  // see the `SUSPICIOUS_CORRECTION_DB` comment above. `null` (never measured, no tag) is also
  // "not trustworthy" in the sense that it needs measuring, but is reported separately by callers
  // since it's not actually suspicious, just absent.
  function isTrustworthyCorrection(db: number | null): db is number {
    return db !== null && Math.abs(db) < SUSPICIOUS_CORRECTION_DB
  }

  // Measures RMS across several snapshots spread over the analyser and returns a clamped
  // correction from their *median* (not a single reading), or null if nothing usable was
  // measured (silence, no context) — a lone quiet passage or transient can badly skew one sample,
  // but is very unlikely to dominate the median of several spread across a few hundred ms to over
  // a second. Pure — has no opinion on which slot/card it's for or what to do with the result;
  // both the preload path and the post-hoc fallback path share it.
  async function measureCorrectionDb(slot: Slot, sampleCount: number): Promise<number | null> {
    const ctx = ctxRef.current
    if (!ctx) return null
    const buffer = new Float32Array(slot.analyser.fftSize)
    const readings: number[] = []

    for (let i = 0; i < sampleCount; i++) {
      await new Promise((resolve) => setTimeout(resolve, GAIN_SAMPLE_INTERVAL_MS))
      slot.analyser.getFloatTimeDomainData(buffer)
      let sumSquares = 0
      for (const sample of buffer) sumSquares += sample * sample
      const rms = Math.sqrt(sumSquares / buffer.length)
      if (rms > 0) readings.push(20 * Math.log10(rms))
    }
    if (readings.length === 0) return null

    readings.sort((a, b) => a - b)
    const measuredDb = readings[Math.floor(readings.length / 2)]
    return Math.max(-MAX_CORRECTION_DB, Math.min(MAX_CORRECTION_DB, TARGET_LOUDNESS_DB - measuredDb))
  }

  // Fallback path only: measures loudness *while the track is already audible* and re-targets the
  // gain ramp mid-flight. Only reached when `activate()` didn't already have a preloaded
  // correction ready (see `preloadNormalization` below) — e.g. a swipe fast enough to outrun the
  // one-card-ahead prefetch window — so there's a brief moment of unnormalized volume before this
  // lands. The normal case avoids that entirely.
  async function measureAndApplyGain(slot: Slot, card: Card, baseGain: number): Promise<void> {
    if (!settingsRef.current.normalize || isTrustworthyCorrection(card.replayGainDb)) return
    const correctionDb = await measureCorrectionDb(slot, FALLBACK_SAMPLE_COUNT)
    if (correctionDb === null) return
    const ctx = ctxRef.current
    if (!ctx) return

    const now = ctx.currentTime
    slot.gain.gain.cancelScheduledValues(now)
    slot.gain.gain.setValueAtTime(slot.gain.gain.value, now)
    slot.gain.gain.linearRampToValueAtTime(baseGain * dbToGain(correctionDb), now + (FADE_IN_MS / 1000) * 0.4)
    slot.appliedCorrectionDb = correctionDb

    window.purgewave.cacheGain(card.id, correctionDb)
  }

  // Runs while a card is still just the *standby*/next-up track — silent, since the standby
  // slot's gain stays at 0 until `activate()` ping-pongs onto it — so that by the time this track
  // actually becomes the front card, its correction is already known and gets applied from gain
  // ramp-up's very first instant. Without this, normalization for an untagged track could only
  // ever be measured *after* the track was already audible, producing a brief moment of raw
  // (un-normalized) volume on every single swipe to an untagged track.
  async function preloadNormalization(slot: Slot, card: Card): Promise<void> {
    if (!settingsRef.current.normalize || isTrustworthyCorrection(card.replayGainDb) || card.previewUnsupported) return
    if (slot.preparedFor !== card.id || slot.pendingGainDb !== null) return

    const savedTime = slot.el.currentTime
    try {
      await slot.el.play()
    } catch {
      return // silent play can fail under stricter autoplay policies; just skip the preload
    }
    // This path is hidden (silent, ahead of when the track is actually needed), so it can afford
    // far more samples spread over a much longer stretch than the fallback path can — that's what
    // actually makes the median resistant to a quiet intro or a sparse passage skewing it. It can
    // take over a second, though, which is long enough that the user may have already swiped to
    // this exact card while it was running — `activate()` promotes a slot to real, audible
    // playback without waiting on this function, so that's a normal outcome, not an error.
    const correctionDb = await measureCorrectionDb(slot, PRELOAD_SAMPLE_COUNT)

    // If this slot is now the truly active (audible) one, `activate()` got there first — pausing
    // and rewinding it here would yank the front card's real playback backwards mid-listen. Bail
    // entirely rather than touch it: `activate()` already found no preloaded correction ready at
    // the time it ran, so it will have started its own concurrent `measureAndApplyGain` fallback
    // on this same slot, which owns applying/caching the correction from here on.
    if (slotsRef.current?.[activeIndexRef.current] === slot) return

    slot.el.pause()
    slot.el.currentTime = savedTime // undo the time this silent priming play advanced

    // The slot may have moved on to a different card while the above awaits were in flight —
    // don't attach a stale measurement to whatever it's preparing now.
    if (slot.preparedFor !== card.id || correctionDb === null) return
    slot.pendingGainDb = correctionDb
    window.purgewave.cacheGain(card.id, correctionDb)
  }

  async function prepare(slot: Slot, card: Card): Promise<void> {
    if (slot.preparedFor === card.id) return
    slot.preparedFor = card.id
    slot.seekFailed = false
    slot.pendingGainDb = null

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
      // Prefer, in order: a trustworthy tag/cached value — exact and free (see
      // `isTrustworthyCorrection`: a value sitting right at the clamp boundary is treated as an
      // unproven one-off, not final, and re-measured instead of trusted forever). A preloaded
      // measurement — taken silently while this track was still just the standby, one card ahead
      // — the normal case for an untagged track. Only when neither is available (this card became
      // front faster than the one-card-ahead prefetch could measure it) does gain start
      // unadjusted and get corrected a beat later by the `measureAndApplyGain` fallback below.
      const trustworthyTag = isTrustworthyCorrection(frontCard!.replayGainDb)
      const hasCorrection = trustworthyTag || incoming.pendingGainDb !== null
      const correctionDb = trustworthyTag ? frontCard!.replayGainDb! : (incoming.pendingGainDb ?? 0)
      incoming.pendingGainDb = null
      const gainAdjustDb = settingsRef.current.normalize ? correctionDb : 0
      incoming.appliedCorrectionDb = gainAdjustDb
      const target = baseGain * dbToGain(gainAdjustDb)

      if (!frontCard!.previewUnsupported && settingsRef.current.autoplay) {
        void incoming.el.play().catch(() => {})
        fadeGain(incoming, target, FADE_IN_MS)
        // Fallback path only — skipped when a tag or a preloaded measurement already covered it.
        if (settingsRef.current.normalize && !hasCorrection) {
          void measureAndApplyGain(incoming, frontCard!, baseGain)
        }
      }
    }

    void activate()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontCard?.id])

  // The activate effect above bails out immediately (`if (!frontCard) return`) once the queue is
  // exhausted and the summary screen appears — which previously meant whatever was still audible
  // just kept playing indefinitely, since nothing else ever told it to stop. This fades it out and
  // pauses it the same way a swipe's crossfade would, instead of letting it play on unattended or
  // cutting it off with a hard click on the eventual unmount.
  useEffect(() => {
    if (frontCard) return
    const slots = slotsRef.current
    if (!slots) return
    const active = slots[activeIndexRef.current]
    if (active.el.paused) return
    fadeGain(active, 0, FADE_OUT_MS)
    const timer = setTimeout(() => active.el.pause(), FADE_OUT_MS)
    return () => clearTimeout(timer)
  }, [frontCard])

  useEffect(() => {
    if (!nextCard) return
    const slots = slotsRef.current
    if (!slots) return
    // assignedIndexRef, not activeIndexRef — see the comment above the frontCard effect. This
    // must reflect which slot the *current* front card claimed, even before its own activation
    // has finished, or this can prefetch onto the slot that's still mid-activation.
    const standby = slots[1 - assignedIndexRef.current]
    void prepare(standby, nextCard).then(() => preloadNormalization(standby, nextCard))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCard?.id])

  // Live volume changes re-target the active element's gain (not a fade — an immediate but
  // click-free ramp), never the passive HTMLMediaElement.volume, which the GainNode replaces. The
  // volume slider is a *relative* multiplier on top of whatever correction is already in effect —
  // reads `active.appliedCorrectionDb` (set once in `activate()`/`measureAndApplyGain`, whichever
  // last touched this slot), not `card.replayGainDb`. That field stays `null` in this component's
  // own `card` prop for an untagged track's entire playback (a measurement updates library.json
  // and this slot, not the prop React is holding), so recomputing from it here used to silently
  // throw away a live measured correction and jump back to raw, un-normalized volume the instant
  // the slider moved — heard as some untagged tracks suddenly playing very loud after a volume
  // adjustment.
  useEffect(() => {
    const slots = slotsRef.current
    const card = frontCard
    if (!slots || !card || card.previewUnsupported) return
    const active = slots[activeIndexRef.current]
    fadeGain(active, settings.volume * dbToGain(settings.normalize ? active.appliedCorrectionDb : 0), 60)
    // Also re-applies when `normalize` itself is toggled mid-playback (the Settings checkbox is
    // reachable during an active session), so switching it off immediately drops back to raw
    // volume instead of waiting for the next swipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.volume, settings.normalize])

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
