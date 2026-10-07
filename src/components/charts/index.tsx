// Lightweight SVG charts. Specs: 2px lines, ~10% area wash, ≤24px columns with
// 4px rounded data-ends, hairline recessive grid, hover tooltips on every chart,
// text in text tokens (never series colour). Multi-series identity uses the
// validated categorical palette (--series-N), assigned by entity order.
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from '@/components/ui'

export const seriesColor = (i: number) => `var(--series-${(i % 8) + 1})`

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * exp
}

function useMeasure() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const obs = useRef<ResizeObserver | null>(null)
  const set = (el: HTMLDivElement | null) => {
    ;(ref as { current: HTMLDivElement | null }).current = el
    obs.current?.disconnect()
    if (el) {
      obs.current = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)))
      obs.current.observe(el)
    }
  }
  return [set, w] as const
}

function Tooltip({ x, y, children, width }: { x: number; y: number; children: ReactNode; width: number }) {
  const left = Math.min(Math.max(x, 70), width - 70)
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-xl"
      style={{ left, top: y - 8 }}
    >
      {children}
    </div>
  )
}

export interface Point {
  label: string
  value: number
  sub?: string
}

/** Single-series area/line chart with crosshair + tooltip. */
export function AreaChart({ data, height = 200, format = (v) => String(v), color = 'var(--accent)', ariaLabel }: {
  data: Point[]
  height?: number
  format?: (v: number) => string
  color?: string
  ariaLabel: string
}) {
  const [ref, width] = useMeasure()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 44, r: 12, t: 12, b: 24 }
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)))
  const iw = width - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw)
  const y = (v: number) => pad.t + ih - (v / max) * ih
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.value)}`).join('')
  const area = data.length ? `${line}L${x(data.length - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z` : ''
  const ticks = [0, max / 2, max]
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 70))))

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = e.clientX - r.left - pad.l
          const i = data.length <= 1 ? 0 : Math.round((px / iw) * (data.length - 1))
          setHover(Math.max(0, Math.min(data.length - 1, i)))
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--faint)] text-[10px] tnum">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => i % labelEvery === 0 && (
          <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">{d.label}</text>
        ))}
        <path d={area} fill={color} opacity={0.1} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && data[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--border-strong)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(data[hover].value)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        {data.length > 0 && hover === null && (
          <circle cx={x(data.length - 1)} cy={y(data[data.length - 1].value)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
        )}
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip x={x(hover)} y={y(data[hover].value)} width={width}>
          <div className="text-muted">{data[hover].sub ?? data[hover].label}</div>
          <div className="font-semibold tnum">{format(data[hover].value)}</div>
        </Tooltip>
      )}
    </div>
  )
}

/** Vertical columns (single series). */
export function ColumnChart({ data, height = 180, format = (v) => String(v), highlight, ariaLabel, color = 'var(--accent)' }: {
  data: Point[]
  height?: number
  format?: (v: number) => string
  highlight?: number
  ariaLabel: string
  color?: string
}) {
  const [ref, width] = useMeasure()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 36, r: 8, t: 10, b: 22 }
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)))
  const iw = width - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const band = iw / Math.max(1, data.length)
  const bw = Math.min(24, Math.max(4, band - 2))
  const y = (v: number) => pad.t + ih - (v / max) * ih
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 36))))
  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--faint)] text-[10px] tnum">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx0 = pad.l + band * i + band / 2
          const h = Math.max(0, pad.t + ih - y(d.value))
          const r = Math.min(4, h)
          const x0 = cx0 - bw / 2
          const top = pad.t + ih - h
          const path = h > 0
            ? `M${x0},${pad.t + ih}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${pad.t + ih}Z`
            : ''
          const dim = hover !== null ? hover !== i : highlight !== undefined && highlight !== i
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + band * i} y={pad.t} width={band} height={ih} fill="transparent" />
              {path && <path d={path} fill={color} opacity={dim ? 0.45 : 1} />}
              {i % labelEvery === 0 && (
                <text x={cx0} y={height - 6} textAnchor="middle" className="fill-[var(--faint)] text-[10px]">{d.label}</text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip x={pad.l + band * hover + band / 2} y={y(data[hover].value)} width={width}>
          <div className="text-muted">{data[hover].sub ?? data[hover].label}</div>
          <div className="font-semibold tnum">{format(data[hover].value)}</div>
        </Tooltip>
      )}
    </div>
  )
}

/** Ranked horizontal bars with labels and value at the tip. */
export function BarList({ items, format = (v) => String(v), colorFor, max: maxProp }: {
  items: { key: string; label: ReactNode; value: number; sub?: ReactNode; colorIndex?: number }[]
  format?: (v: number) => string
  colorFor?: (i: number) => string
  max?: number
}) {
  const max = maxProp ?? Math.max(1, ...items.map((i) => i.value))
  return (
    <ul className="space-y-3">
      {items.map((it, i) => (
        <li key={it.key} className="group" title={`${typeof it.label === 'string' ? it.label : ''} ${format(it.value)}`}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 truncate">
              {colorFor && <span className="size-2 shrink-0 rounded-full" style={{ background: colorFor(it.colorIndex ?? i) }} />}
              <span className="truncate">{it.label}</span>
              {it.sub && <span className="text-xs text-muted">{it.sub}</span>}
            </span>
            <span className="font-semibold tnum">{format(it.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div
              className="h-2 rounded-full transition-[width] duration-700 group-hover:brightness-110"
              style={{ width: `${Math.max(1.5, (it.value / max) * 100)}%`, background: colorFor ? colorFor(it.colorIndex ?? i) : 'var(--accent)' }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Weekday × hour load heatmap (sequential, single accent hue). */
export function Heatmap({ cells, weekStartsOn = 1 }: { cells: { dow: number; hour: number; utilization: number | null; booked_minutes: number; available_minutes: number }[]; weekStartsOn?: number }) {
  const [hover, setHover] = useState<string | null>(null)
  const hours = useMemo(() => {
    const hs = cells.map((c) => c.hour)
    if (!hs.length) return []
    const lo = Math.min(...hs)
    const hi = Math.max(...hs)
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  }, [cells])
  const days = Array.from({ length: 7 }, (_, i) => (i + weekStartsOn) % 7)
  const map = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]))
  const fmtHour = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`)
  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {hours.map((h) => (
              <th key={h} className="px-0.5 text-center text-[10px] font-normal text-faint">{fmtHour(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d}>
              <td className="pr-2 text-[11px] text-muted">{DOW[d]}</td>
              {hours.map((h) => {
                const c = map.get(`${d}-${h}`)
                const u = c?.utilization ?? null
                const k = `${d}-${h}`
                return (
                  <td key={h} className="relative p-0" onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
                    <div
                      className={cx('h-7 min-w-[22px] rounded-[5px]', !c && 'bg-surface-2/50')}
                      style={c ? { background: `color-mix(in oklab, var(--accent) ${Math.round(12 + (u ?? 0) * 0.88)}%, var(--surface-2))` } : undefined}
                    />
                    {hover === k && c && (
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-xl">
                        <div className="text-muted">{DOW[d]} {fmtHour(h)}</div>
                        <div className="font-semibold tnum">{u === null ? '—' : `${Math.round(u)}% booked`}</div>
                        <div className="text-muted tnum">{Math.round(c.booked_minutes)} of {Math.round(c.available_minutes)} chair-min</div>
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
        <span>0%</span>
        <div className="h-2 w-28 rounded-full" style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--accent) 12%, var(--surface-2)), var(--accent))' }} />
        <span>100% booked</span>
      </div>
    </div>
  )
}

/** Semi-circular gauge for a single % KPI against a target. */
export function Gauge({ value, target, label, size = 160 }: { value: number | null; target?: number; label?: string; size?: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  const r = size / 2 - 10
  const c = Math.PI * r
  const angle = (p: number) => Math.PI * (1 - p / 100)
  const tx = target !== undefined ? size / 2 + r * Math.cos(angle(target)) : 0
  const ty = target !== undefined ? size / 2 - r * Math.sin(angle(target)) : 0
  return (
    <div className="relative" style={{ width: size, height: size / 2 + 18 }}>
      <svg width={size} height={size / 2 + 10} role="img" aria-label={`${label ?? 'Value'} ${value === null ? 'no data' : `${v.toFixed(0)}%`}`}>
        <path d={`M10,${size / 2} A${r},${r} 0 0 1 ${size - 10},${size / 2}`} fill="none" stroke="var(--surface-3)" strokeWidth={10} strokeLinecap="round" />
        {value !== null && (
          <path d={`M10,${size / 2} A${r},${r} 0 0 1 ${size - 10},${size / 2}`} fill="none" stroke="var(--accent)" strokeWidth={10} strokeLinecap="round"
            strokeDasharray={`${(v / 100) * c} ${c}`} style={{ transition: 'stroke-dasharray .8s ease' }} />
        )}
        {target !== undefined && <circle cx={tx} cy={ty} r={4} fill="var(--text)" stroke="var(--surface)" strokeWidth={2} />}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="text-2xl font-semibold leading-none tnum">{value === null ? '—' : `${Math.round(v)}%`}</div>
        {target !== undefined && <div className="mt-1 text-[11px] text-muted">Target {target}%</div>}
      </div>
    </div>
  )
}

export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - (v / max) * (height - 4)}`).join(' ')
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={width} cy={height - 2 - (values[values.length - 1] / max) * (height - 4)} r={2.5} fill="var(--accent)" />
    </svg>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}
