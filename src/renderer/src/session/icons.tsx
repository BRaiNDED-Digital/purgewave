interface IconProps {
  size?: number
  className?: string
}

/** A real cog, filled solid — a toothed ring around a hub, not an outlined sun-like glyph. */
export function GearIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l.68 1.178a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.226l1.267 1.113a1 1 0 0 1 .206 1.25l-.68 1.179a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-.68-1.178a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.225L2.821 7.4a1 1 0 0 1-.206-1.25l.68-1.179a1 1 0 0 1 1.187-.447l1.598.54A6.993 6.993 0 0 1 8.01 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      />
    </svg>
  )
}

/** A keyboard keycap — a bordered square with a raised bottom edge, holding a single letter. */
export function KeyCap({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="flex h-6 w-6 items-center justify-center rounded-md border text-xs font-bold"
      style={{ borderColor: color, borderBottomWidth: 2.5, color }}
    >
      {label}
    </span>
  )
}

/** Counter-clockwise arc with an arrowhead — a plain, recognizable "undo" glyph. */
export function UndoIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M3.5 7.5A5 5 0 1 1 4.9 11.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M4.2 4v3.6H7.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/** Speaker glyph — sound waves swap for a small "muted" cross when `muted` is set. */
export function SpeakerIcon({ size = 16, muted, className }: IconProps & { muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M1.5 6h2.4l3.4-2.9v9.8L3.9 10H1.5V6Z" fill="currentColor" />
      {muted ? (
        <path
          d="M10.5 6.2 13.5 9.8M13.5 6.2 10.5 9.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path d="M10.3 5.7a3 3 0 0 1 0 4.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
          <path d="M12.1 4a5.6 5.6 0 0 1 0 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </>
      )}
    </svg>
  )
}

/** A filled rounded square — the universal "stop" glyph, for ending a session. */
export function StopIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
    </svg>
  )
}

/** The infinity/pretzel loop glyph — stands in for "Unlimited" in the session-length toggles. */
export function InfinityIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M4.5 5.5a2.5 2.5 0 1 0 0 5c1.5 0 2.2-1 3.5-2.5 1.3 1.5 2 2.5 3.5 2.5a2.5 2.5 0 1 0 0-5c-1.5 0-2.2 1-3.5 2.5-1.3-1.5-2-2.5-3.5-2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
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
