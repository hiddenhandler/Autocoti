import { forwardRef, useId, type SVGProps } from 'react'
import type { LiveStatus } from '@/lib/types'

/**
 * Barber chair line icon — drop-in for lucide icons (24px grid, 2px rounded strokes).
 * Headrest, reclined back, seat, armrest, hydraulic column and round base.
 */
export const BarberChairIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement> & { strokeWidth?: number }>(function BarberChairIcon(
  { strokeWidth = 2, className, ...props },
  ref,
) {
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden {...props}>
      <path d="M8 2.5h4" />
      <path d="M10 2.5v2" />
      <path d="M7.5 4.5h5l-1 7.5h-5z" />
      <path d="M5.5 12h11a1.5 1.5 0 0 1 0 3h-11a1.5 1.5 0 0 1 0-3z" />
      <path d="M13.5 9.5h4" />
      <path d="M11 15v4" />
      <path d="M6.5 21.5a4.5 1.5 0 0 0 9 0" />
      <path d="M6.5 21.5h9" />
      <path d="M17 15l2 3" />
    </svg>
  )
})

const STATUS_COLOR: Record<LiveStatus | 'EMPTY', string> = {
  AVAILABLE: 'var(--success)',
  CUTTING: 'var(--accent)',
  BOOKED: 'var(--accent)',
  BREAK: 'var(--warning)',
  QUEUE: 'var(--info)',
  OFFLINE: 'var(--danger)',
  NOT_WORKING: 'var(--faint)',
  EMPTY: 'var(--faint)',
}

/**
 * Three-quarter view barber chair with leather, chrome and a status-coloured floor glow.
 * Pure SVG (no assets) so it themes with the app and stays crisp at any size.
 */
export function BarberChair3D({ status = 'EMPTY', className, dim }: { status?: LiveStatus | 'EMPTY'; className?: string; dim?: boolean }) {
  const id = useId().replace(/:/g, '')
  const glow = STATUS_COLOR[status]
  const g = (n: string) => `url(#${n}${id})`
  return (
    <svg viewBox="0 0 220 190" className={className} role="img" aria-label="Barber chair" style={{ opacity: dim ? 0.55 : 1 }}>
      <defs>
        <radialGradient id={`glow${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={glow} stopOpacity="0.9" />
          <stop offset="0.55" stopColor={glow} stopOpacity="0.28" />
          <stop offset="1" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`leather${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4d5663" />
          <stop offset="0.45" stopColor="#2a3039" />
          <stop offset="1" stopColor="#121519" />
        </linearGradient>
        <linearGradient id={`leatherSide${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d2128" />
          <stop offset="1" stopColor="#0d0f12" />
        </linearGradient>
        <linearGradient id={`sheen${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`chrome${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6b7480" />
          <stop offset="0.3" stopColor="#f4f7fa" />
          <stop offset="0.55" stopColor="#9aa4b2" />
          <stop offset="0.8" stopColor="#e3e8ee" />
          <stop offset="1" stopColor="#5b6573" />
        </linearGradient>
        <linearGradient id={`chromeV${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eef2f6" />
          <stop offset="1" stopColor="#6b7480" />
        </linearGradient>
      </defs>

      {/* floor glow + contact shadow */}
      <ellipse cx="110" cy="170" rx="100" ry="20" fill={g('glow')} />
      <ellipse cx="110" cy="171" rx="52" ry="7" fill="#000" opacity="0.45" />

      {/* round chrome base */}
      <ellipse cx="110" cy="166" rx="48" ry="10" fill={g('chromeV')} />
      <ellipse cx="110" cy="163" rx="48" ry="10" fill={g('chrome')} />
      <ellipse cx="110" cy="162" rx="30" ry="5.5" fill="#000" opacity="0.18" />

      {/* hydraulic column + pump pedal */}
      <rect x="101" y="116" width="18" height="47" rx="3" fill={g('chrome')} />
      <rect x="98" y="114" width="24" height="6" rx="3" fill={g('chrome')} />
      <path d="M119 152 l22 6 a3 3 0 0 1 -1.5 5.6 l-21 -4.5z" fill={g('chromeV')} />

      {/* footrest */}
      <path d="M150 118 L168 146" stroke={g('chromeV')} strokeWidth="4" strokeLinecap="round" />
      <rect x="152" y="143" width="34" height="8" rx="4" fill={g('chrome')} />

      {/* backrest (reclined) */}
      <path d="M44 32 Q46 22 58 22 L86 22 Q97 22 96 33 L88 100 L48 104 Q40 104 41 94 Z" fill={g('leather')} stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
      <path d="M44 32 Q46 22 58 22 L86 22 Q97 22 96 33 L95 40 Q70 30 45 44 Z" fill={g('sheen')} />
      {/* tufted stitching */}
      <path d="M52 44 L87 41 M50 62 L85 59 M49 80 L83 77" stroke="#000" strokeOpacity="0.35" strokeWidth="1.2" />
      <path d="M52 45 L87 42 M50 63 L85 60 M49 81 L83 78" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="0.8" strokeDasharray="2 2.5" />

      {/* headrest on chrome stem */}
      <rect x="66" y="10" width="5" height="14" rx="2" fill={g('chrome')} />
      <rect x="50" y="2" width="38" height="12" rx="6" fill={g('leather')} stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
      <rect x="54" y="3.5" width="28" height="3" rx="1.5" fill="#fff" opacity="0.12" />

      {/* seat cushion: top + front face */}
      <path d="M40 98 Q40 90 50 90 L146 90 Q158 90 158 100 L158 104 Q158 112 146 112 L52 114 Q40 114 40 106 Z" fill={g('leather')} stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
      <path d="M40 106 Q40 114 52 114 L146 112 Q158 112 158 104 L158 116 Q158 124 146 124 L52 126 Q40 126 40 118 Z" fill={g('leatherSide')} />
      <path d="M50 92 L146 92 Q154 92 155 98 Q100 92 46 100 Q46 93 50 92 Z" fill={g('sheen')} />
      <path d="M48 118 L150 116" stroke="var(--accent)" strokeOpacity="0.4" strokeWidth="0.8" strokeDasharray="2 2.5" />

      {/* armrests with chrome supports */}
      <rect x="62" y="104" width="4" height="12" rx="1.5" fill={g('chrome')} transform="translate(-8 -24)" />
      <path d="M36 76 Q36 70 44 70 L104 70 Q112 70 112 76 Q112 82 104 82 L44 82 Q36 82 36 76 Z" fill={g('leather')} stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
      <path d="M40 72 L106 72" stroke="#fff" strokeOpacity="0.14" strokeWidth="2" strokeLinecap="round" />
      <rect x="96" y="82" width="5" height="9" rx="1.5" fill={g('chrome')} />
      <path d="M118 80 Q118 74 126 74 L160 74 Q168 74 168 80 Q168 86 160 86 L126 86 Q118 86 118 80 Z" fill={g('leather')} stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
      <rect x="150" y="86" width="5" height="6" rx="1.5" fill={g('chrome')} />
    </svg>
  )
}
