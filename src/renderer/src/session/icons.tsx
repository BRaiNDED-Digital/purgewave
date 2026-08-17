interface IconProps {
  size?: number
  className?: string
}

export function GearIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1.06 1.06M4.56 11.44 3.5 12.5M12.5 12.5l-1.06-1.06M4.56 4.56 3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function BarChartIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="1.5" y="9" width="3" height="5.5" rx="0.6" fill="currentColor" />
      <rect x="6.5" y="4.5" width="3" height="10" rx="0.6" fill="currentColor" />
      <rect x="11.5" y="1.5" width="3" height="13" rx="0.6" fill="currentColor" />
    </svg>
  )
}

/** A simple two-button mouse outline with one side (left or right click) filled solid. */
export function MouseGlyph({ side, size = 20 }: { side: 'left' | 'right'; size?: number }) {
  const height = Math.round(size * 1.3)
  return (
    <svg width={size} height={height} viewBox="0 0 20 26" fill="none">
      <rect x="1" y="1" width="18" height="24" rx="9" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.3" />
      <line x1="10" y1="1" x2="10" y2="10.5" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.3" />
      <path
        d={side === 'left' ? 'M1.5 10.5H10V1.6A9 9 0 0 0 1.5 10.5Z' : 'M18.5 10.5H10V1.6A9 9 0 0 1 18.5 10.5Z'}
        fill="currentColor"
      />
    </svg>
  )
}

export function ArrowGlyph({ direction, size = 13 }: { direction: 'left' | 'right'; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ transform: direction === 'left' ? 'scaleX(-1)' : undefined }}
    >
      <path
        d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
