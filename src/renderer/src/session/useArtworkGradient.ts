import { useEffect, useRef, useState } from 'react'

const SAMPLE_SIZE = 16
// Real album art is overwhelmingly square; this just keeps a rare extreme (a tall poster crop,
// a wide banner someone stuffed into ID3 art) from producing a card that dominates or vanishes
// from the layout. 0.75–1.5 covers 3:4 portrait through 3:2 landscape.
const MIN_ASPECT_RATIO = 0.75
const MAX_ASPECT_RATIO = 1.5

interface Rgb {
  r: number
  g: number
  b: number
}

export interface ArtworkVisuals {
  gradient: string | null
  /** width / height, clamped — 1 (square) when there's no artwork or extraction failed. */
  aspectRatio: number
  /** A muted, semi-transparent tone derived from the artwork, for the card's own border. Null
   *  when there's no artwork or color extraction failed — callers fall back to the flat token. */
  borderColor: string | null
}

const DEFAULT_VISUALS: ArtworkVisuals = { gradient: null, aspectRatio: 1, borderColor: null }

function averageRegion(data: Uint8ClampedArray, size: number, x0: number, y0: number, x1: number, y1: number): Rgb {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 4
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      count++
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0 }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0)
      break
    case g:
      h = (b - r) / d + 2
      break
    default:
      h = (r - g) / d + 4
  }
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  }
}

// Real-world album art is often fairly desaturated/dark/light — averaging a 8x8 block only makes
// that worse (it tends toward grey). Boosting saturation and pulling lightness into a mid band
// keeps the gradient a clearly visible color instead of washing out to near-white/near-black/grey
// against the card's own surface tone.
function vivify(rgb: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(rgb.r, rgb.g, rgb.b)
  const boostedS = Math.min(1, s * 1.8 + 0.2)
  const clampedL = Math.min(0.72, Math.max(0.28, l))
  return hslToRgb(h, boostedS, clampedL)
}

function rgba({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function clampAspectRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1
  return Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, ratio))
}

// Cross-request cache, not per-hook-instance: a card mounts a fresh SwipeCard (and this hook)
// every time it re-enters the stack, and the invisible sizer in SwipeScreen calls this same hook
// a second time for whichever card is currently in front — caching on the module keeps both from
// re-decoding the same artwork.
const visualsCache = new Map<string, ArtworkVisuals>()

/**
 * Samples an artwork image at low resolution to derive both its dominant colors (a soft,
 * multi-blob gradient — "blurred" via wide, transparent-falling gradient stops rather than an
 * actual blur filter, which would need an oversized layer to avoid edge clipping under the
 * card's `overflow: hidden`) and its true aspect ratio (so the artwork region — and therefore
 * the whole card — can size itself to the real image instead of force-cropping everything into a
 * fixed box). Only the four corners are sampled/blended for the gradient, never the full image
 * behind text, so the tuned WCAG AA text-contrast pairings (styles.css) stay intact.
 */
export function useArtworkGradient(dataUrl: string | null): ArtworkVisuals {
  const [visuals, setVisuals] = useState<ArtworkVisuals>(() =>
    dataUrl ? visualsCache.get(dataUrl) ?? DEFAULT_VISUALS : DEFAULT_VISUALS
  )
  const requestedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!dataUrl) {
      setVisuals(DEFAULT_VISUALS)
      return
    }
    const cached = visualsCache.get(dataUrl)
    if (cached) {
      setVisuals(cached)
      return
    }
    requestedFor.current = dataUrl
    let cancelled = false

    const img = new Image()
    img.onload = () => {
      if (cancelled || requestedFor.current !== dataUrl) return
      const aspectRatio = clampAspectRatio(img.naturalWidth / img.naturalHeight)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_SIZE
        canvas.height = SAMPLE_SIZE
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        const half = SAMPLE_SIZE / 2

        const topLeft = vivify(averageRegion(data, SAMPLE_SIZE, 0, 0, half, half))
        const topRight = vivify(averageRegion(data, SAMPLE_SIZE, half, 0, SAMPLE_SIZE, half))
        const bottom = vivify(averageRegion(data, SAMPLE_SIZE, 0, half, SAMPLE_SIZE, SAMPLE_SIZE))
        // Whole-image average (not one of the three gradient blobs) so the border reads as the
        // artwork's overall tone rather than favoring whichever corner it happens to match.
        const dominant = vivify(averageRegion(data, SAMPLE_SIZE, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE))

        // Stop positions are expressed as percentages of whatever box this gradient ends up
        // painted on — currently the text panel itself (see CardBody), not the whole card, so
        // all three blobs actually land inside the visible panel instead of two of them being
        // hidden behind the opaque artwork region above it.
        const gradient = [
          `radial-gradient(140% 100% at 10% 0%, ${rgba(topLeft, 0.6)}, transparent 65%)`,
          `radial-gradient(140% 100% at 90% 10%, ${rgba(topRight, 0.5)}, transparent 70%)`,
          `radial-gradient(160% 120% at 50% 100%, ${rgba(bottom, 0.5)}, transparent 75%)`
        ].join(', ')

        const result = { gradient, aspectRatio, borderColor: rgba(dominant, 0.55) }
        visualsCache.set(dataUrl, result)
        if (!cancelled) setVisuals(result)
      } catch {
        // Color extraction is a purely cosmetic enhancement — a decode/canvas failure just falls
        // back to no gradient/border, but the aspect ratio (already known from the loaded image)
        // is real layout information and still worth keeping.
        const result = { gradient: null, aspectRatio, borderColor: null }
        visualsCache.set(dataUrl, result)
        if (!cancelled) setVisuals(result)
      }
    }
    img.onerror = () => {
      if (!cancelled) setVisuals(DEFAULT_VISUALS)
    }
    img.src = dataUrl

    return () => {
      cancelled = true
    }
  }, [dataUrl])

  return visuals
}
