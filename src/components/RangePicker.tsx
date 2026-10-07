import { useState } from 'react'
import { rangeFor, type DateStr, type RangeKey } from '@/lib/time'
import { Input, Segmented } from './ui'

export function useRange(tz: string, initial: RangeKey = '30d') {
  const [key, setKey] = useState<RangeKey>(initial)
  const [custom, setCustom] = useState<{ from: DateStr; to: DateStr }>(rangeFor('30d', tz))
  const range = rangeFor(key, tz, custom)
  return { key, setKey, range, custom, setCustom }
}

export function RangePicker({ value, onChange, custom, onCustom, keys = ['today', 'yesterday', '7d', '30d', '90d', 'custom'] }: {
  value: RangeKey
  onChange: (k: RangeKey) => void
  custom: { from: DateStr; to: DateStr }
  onCustom: (c: { from: DateStr; to: DateStr }) => void
  keys?: RangeKey[]
}) {
  const labels: Record<RangeKey, string> = { today: 'Today', yesterday: 'Yesterday', '7d': '7 days', '30d': '30 days', '90d': '90 days', mtd: 'Month', custom: 'Custom' }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented size="sm" value={value} onChange={onChange} options={keys.map((k) => ({ value: k, label: labels[k] }))} />
      {value === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Input type="date" className="h-8 w-[150px] text-sm" value={custom.from} max={custom.to} onChange={(e) => e.target.value && onCustom({ ...custom, from: e.target.value })} />
          <span className="text-muted">–</span>
          <Input type="date" className="h-8 w-[150px] text-sm" value={custom.to} min={custom.from} onChange={(e) => e.target.value && onCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
    </div>
  )
}
