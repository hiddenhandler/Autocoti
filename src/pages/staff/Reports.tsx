import { useState } from 'react'
import { Download, Printer, Star } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useAnalytics, useBarbers } from '@/lib/api'
import { dateStrLabel, delta, minutes, money, num, pct } from '@/lib/format'
import { WEEKDAY_SHORT } from '@/lib/time'
import { downloadCsv } from '@/lib/csv'
import type { Analytics } from '@/lib/types'
import { RangePicker, useRange } from '@/components/RangePicker'
import { AreaChart, BarList, ColumnChart, Gauge, Heatmap, Legend, seriesColor } from '@/components/charts'
import { Button, Card, CardHeader, cx, EmptyState, PageHeader, Segmented, Select, Skeleton, Stat } from '@/components/ui'

export default function Reports() {
  const { ws, can } = useWorkspace()
  const { key, setKey, range, custom, setCustom } = useRange(ws.timezone, '30d')
  const [barberId, setBarberId] = useState('')
  const { data: barbers } = useBarbers(ws.shop_id, { includeArchived: true })
  const { data: a, isLoading, error } = useAnalytics(ws.shop_id, range.from, range.to, barberId || null, can('reports.shop'))
  if (!can('reports.shop')) return <EmptyState title="Reports are for owners and managers" />

  return (
    <div>
      <PageHeader title="Reports" subtitle={`${dateStrLabel(range.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${dateStrLabel(range.to, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        actions={
          <div className="no-print flex flex-wrap items-center gap-2">
            <RangePicker value={key} onChange={setKey} custom={custom} onCustom={setCustom} />
            <Select className="h-9 w-40" value={barberId} onChange={(e) => setBarberId(e.target.value)} aria-label="Barber">
              <option value="">Whole shop</option>
              {barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
            </Select>
            <Button variant="secondary" size="sm" icon={<Printer className="size-4" />} onClick={() => window.print()}>PDF</Button>
          </div>
        } />
      {isLoading ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div> : error || !a ? <EmptyState title="Couldn't load reports" body={String((error as Error)?.message ?? '')} /> : <Body a={a} barberIndex={(id) => barbers?.findIndex((b) => b.id === id) ?? 0} />}
    </div>
  )
}

function Body({ a, barberIndex }: { a: Analytics; barberIndex: (id: string) => number }) {
  const s = a.summary
  const p = a.previous
  const [metric, setMetric] = useState<'revenue' | 'bookings' | 'new_clients' | 'tips'>('revenue')
  const series = a.series.map((x) => ({
    label: dateStrLabel(x.date, { month: 'short', day: 'numeric' }),
    value: metric === 'revenue' ? x.revenue_cents : metric === 'tips' ? x.tips_cents : metric === 'bookings' ? x.bookings : x.new_clients,
  }))
  const isMoney = metric === 'revenue' || metric === 'tips'
  const hasActivity = s.bookings > 0 || s.tickets > 0
  const moneyRows = a.barbers.filter((b) => b.net_revenue_cents !== null)

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <Card className="grid grid-cols-2 gap-x-6 gap-y-7 p-6 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Net revenue" value={money(s.net_revenue_cents, { cents: false })} delta={delta(s.net_revenue_cents, p.net_revenue_cents)} />
        <Stat label="Avg ticket" value={money(s.avg_ticket_cents)} delta={delta(s.avg_ticket_cents, p.avg_ticket_cents)} />
        <Stat label="Tips" value={money(a.revenue.tips_cents, { cents: false })} delta={delta(s.tips_cents, p.tips_cents)} />
        <Stat label="Bookings" value={num(s.bookings)} delta={delta(s.bookings, p.bookings)} />
        <Stat label="Utilization" value={pct(s.utilization)} sub={p.utilization !== null && s.utilization !== null ? `${(s.utilization - p.utilization) >= 0 ? '+' : ''}${(s.utilization - p.utilization).toFixed(1)} pts` : undefined} />
        <Stat label="Rebooking" value={pct(s.rebooking_rate)} sub={`${s.rebooked} of ${s.completed}`} />
        <Stat label="No-shows" value={pct(s.no_show_rate, 1)} sub={`${s.no_shows} total`} inverse />
        <Stat label="Cancellations" value={pct(s.cancellation_rate, 1)} sub={`${s.cancelled} total`} />
      </Card>

      {!hasActivity && (
        <Card><EmptyState title="No activity in this period" body="Once appointments are booked and completed, every chart on this page fills in from real data." /></Card>
      )}

      {/* Trend */}
      <Card>
        <CardHeader title="Over time" action={
          <div className="no-print flex items-center gap-2">
            <Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: 'revenue', label: 'Revenue' }, { value: 'bookings', label: 'Bookings' }, { value: 'new_clients', label: 'New clients' }, { value: 'tips', label: 'Tips' }]} />
            <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => downloadCsv(`daily-${a.period.from}.csv`, a.series.map((x) => ({ date: x.date, revenue: (x.revenue_cents / 100).toFixed(2), tips: (x.tips_cents / 100).toFixed(2), bookings: x.bookings, completed: x.completed, new_clients: x.new_clients })))} aria-label="Export daily CSV" />
          </div>
        } />
        <div className="p-4">
          {a.series.length < 2 ? <ColumnChart ariaLabel="Totals" data={series} format={(v) => (isMoney ? money(v, { compact: true }) : String(Math.round(v)))} />
            : <AreaChart ariaLabel={`${metric} over time`} data={series} format={(v) => (isMoney ? money(v, { compact: true }) : String(Math.round(v)))} />}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Revenue breakdown */}
        <Card>
          <CardHeader title="Money" subtitle="Service revenue is net of discounts; tips tracked separately" />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-5 text-sm tnum">
            {[
              ['Gross service', money(a.revenue.gross_cents)], ['Discounts', `−${money(a.revenue.discount_cents)}`],
              ['Net service revenue', money(a.revenue.net_service_cents)], ['Refunds', `−${money(a.revenue.refunds_cents)}`],
              ['Tips', money(a.revenue.tips_cents)], ['Tax collected', money(a.revenue.tax_cents)],
              ['Policy fees', money(a.revenue.fees_cents)], ['Gift card sales', money(a.revenue.gift_card_sales_cents)],
              ['Total collected', money(a.revenue.collected_cents)], ['Outstanding', money(a.revenue.outstanding_cents)],
              ['Barber commission', money(a.revenue.commission_cents)], ['Shop share (est.)', money(a.revenue.net_service_cents - a.revenue.refunds_cents - a.revenue.commission_cents)],
              ['Revenue / chair-hour', a.utilization.available_minutes ? money(Math.round(s.net_revenue_cents / (a.utilization.available_minutes / 60))) : '—'],
              ['Revenue / client', s.clients_served ? money(Math.round(s.net_revenue_cents / s.clients_served)) : '—'],
            ].map(([k, v]) => <div key={k} className="flex justify-between border-b border-line/60 pb-2"><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>)}
          </dl>
        </Card>

        {/* Revenue by service */}
        <Card>
          <CardHeader title="Revenue by service" action={a.revenue.by_service.length ? <Button size="sm" variant="ghost" icon={<Download className="size-4" />} aria-label="Export" onClick={() => downloadCsv('services.csv', a.revenue.by_service.map((x) => ({ service: x.name, count: x.count, revenue: (x.revenue_cents / 100).toFixed(2) })))} /> : null} />
          <div className="p-5">
            {a.revenue.by_service.length ? <BarList items={a.revenue.by_service.slice(0, 8).map((x) => ({ key: x.name, label: x.name, sub: `${x.count}×`, value: x.revenue_cents }))} format={(v) => money(v, { cents: false })} />
              : <p className="text-sm text-muted">No sales recorded yet.</p>}
          </div>
        </Card>
      </div>

      {/* Barbers */}
      <Card>
        <CardHeader title="Barber performance" action={<Button size="sm" variant="ghost" icon={<Download className="size-4" />} aria-label="Export barber performance" onClick={() => downloadCsv('barbers.csv', a.barbers.map((b) => ({
          barber: b.name, revenue: b.net_revenue_cents !== null ? (b.net_revenue_cents / 100).toFixed(2) : '', cuts: b.cuts, avg_cut_min: b.avg_cut_minutes ?? '', avg_ticket: b.avg_ticket_cents !== null ? (b.avg_ticket_cents / 100).toFixed(2) : '',
          tips: b.tips_cents !== null ? (b.tips_cents / 100).toFixed(2) : '', commission: b.commission_cents !== null ? (b.commission_cents / 100).toFixed(2) : '', clients: b.clients_served, new_clients: b.new_clients,
          returning: b.returning_clients, rebooking_pct: b.rebooking_rate ?? '', no_show_pct: b.no_show_rate ?? '', utilization_pct: b.utilization ?? '', revenue_per_hour: b.revenue_per_hour_cents !== null ? (b.revenue_per_hour_cents / 100).toFixed(2) : '',
        })))} />} />
        {moneyRows.length > 1 && (
          <div className="px-5 pt-5">
            <BarList items={moneyRows.map((b) => ({ key: b.barber_id, label: b.name, value: b.net_revenue_cents ?? 0, colorIndex: barberIndex(b.barber_id) }))} colorFor={seriesColor} format={(v) => money(v, { cents: false })} />
            <div className="mt-3"><Legend items={moneyRows.map((b) => ({ label: b.name, color: seriesColor(barberIndex(b.barber_id)) }))} /></div>
          </div>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm tnum">
            <thead className="border-y border-line text-left text-[11px] uppercase tracking-wider text-muted">
              <tr>{['Barber', 'Revenue', 'Cuts', 'Avg ticket', 'Tips', 'Commission', 'Avg cut', 'Utilization', 'Rev / hr', 'Rebook', 'No-show', 'New / ret.'].map((h) => <th key={h} className="whitespace-nowrap px-4 py-2.5 font-semibold first:pl-5">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {a.barbers.map((b) => (
                <tr key={b.barber_id}>
                  <td className="whitespace-nowrap px-4 py-3 pl-5 font-medium"><span className="mr-2 inline-block size-2 rounded-full" style={{ background: seriesColor(barberIndex(b.barber_id)) }} />{b.name}</td>
                  <td className="px-4 py-3">{b.can_view_money ? money(b.net_revenue_cents, { cents: false }) : '🔒'}</td>
                  <td className="px-4 py-3">{b.cuts}</td>
                  <td className="px-4 py-3">{b.can_view_money ? money(b.avg_ticket_cents) : '—'}</td>
                  <td className="px-4 py-3">{b.can_view_money ? money(b.tips_cents, { cents: false }) : '—'}</td>
                  <td className="px-4 py-3">{b.can_view_money ? money(b.commission_cents, { cents: false }) : '—'}</td>
                  <td className="px-4 py-3">{b.avg_cut_minutes ? minutes(b.avg_cut_minutes) : '—'}</td>
                  <td className="px-4 py-3">{pct(b.utilization)}</td>
                  <td className="px-4 py-3">{b.can_view_money ? money(b.revenue_per_hour_cents, { cents: false }) : '—'}</td>
                  <td className="px-4 py-3">{pct(b.rebooking_rate)}</td>
                  <td className="px-4 py-3">{pct(b.no_show_rate, 1)}</td>
                  <td className="px-4 py-3">{b.new_clients} / {b.returning_clients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {a.barbers.some((b) => !b.can_view_money) && <p className="px-5 py-3 text-xs text-muted">🔒 Individual barber earnings are visible to the owner (or managers granted access).</p>}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Cut time */}
        <Card>
          <CardHeader title="Average cut time" subtitle="From START CUT → FINISH CUT" />
          {!a.cut_time.count ? <EmptyState title="No timed cuts yet" body="Once your first haircut is completed with the timer, your average cut time will appear here." /> : (
            <div className="p-5">
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Actual" value={minutes(a.cut_time.avg_actual_minutes)} />
                <Stat label="Booked" value={minutes(a.cut_time.avg_scheduled_minutes)} />
                <Stat label="Efficiency" value={pct(a.cut_time.efficiency)} hint="Booked ÷ actual. Above 100% = finishing early." sub={`${a.cut_time.count} cuts`} />
              </div>
              <div className="mt-6 grid gap-6 sm:grid-cols-2">
                <div>
                  <div className="eyebrow mb-3">By barber</div>
                  <BarList items={a.cut_time.by_barber.map((b) => ({ key: b.barber_id, label: b.name, sub: `booked ${Math.round(b.scheduled_minutes)}`, value: b.avg_minutes, colorIndex: barberIndex(b.barber_id) }))} colorFor={seriesColor} format={(v) => `${Math.round(v)} min`} />
                </div>
                <div>
                  <div className="eyebrow mb-3">By service</div>
                  <BarList items={a.cut_time.by_service.map((x) => ({ key: x.name, label: x.name, sub: `booked ${Math.round(x.scheduled_minutes)}`, value: x.avg_minutes }))} format={(v) => `${Math.round(v)} min`} />
                </div>
              </div>
              {a.cut_time.by_weekday.length > 1 && (
                <div className="mt-6">
                  <div className="eyebrow mb-2">By day</div>
                  <ColumnChart ariaLabel="Average cut by weekday" height={140} data={a.cut_time.by_weekday.map((d) => ({ label: WEEKDAY_SHORT[d.dow], value: d.avg_minutes, sub: `${WEEKDAY_SHORT[d.dow]} · ${d.count} cuts` }))} format={(v) => `${Math.round(v)}m`} />
                </div>
              )}
              {a.cut_time.by_hour.length > 1 && (
                <div className="mt-6">
                  <div className="eyebrow mb-2">By hour</div>
                  <ColumnChart ariaLabel="Average cut by hour" height={140} data={a.cut_time.by_hour.map((d) => ({ label: hourLabel(d.hour), value: d.avg_minutes, sub: `${hourLabel(d.hour)} · ${d.count} cuts` }))} format={(v) => `${Math.round(v)}m`} />
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Utilization */}
        <Card>
          <CardHeader title="Chair utilization" subtitle="Booked time ÷ available chair time" />
          {!a.utilization.available_minutes ? <EmptyState title="No working hours in this period" /> : (
            <div className="p-5">
              <div className="flex flex-wrap items-center gap-6">
                <Gauge value={a.utilization.utilization} target={a.utilization.target} label="Utilization" />
                <dl className="grid flex-1 grid-cols-2 gap-3 text-sm tnum">
                  <div><dt className="text-muted">Available</dt><dd className="font-semibold">{minutes(a.utilization.available_minutes)}</dd></div>
                  <div><dt className="text-muted">Booked</dt><dd className="font-semibold">{minutes(a.utilization.booked_minutes)}</dd></div>
                  <div><dt className="text-muted">Blocked</dt><dd className="font-semibold">{minutes(a.utilization.blocked_minutes)}</dd></div>
                  <div><dt className="text-muted">Idle</dt><dd className="font-semibold">{minutes(a.utilization.idle_minutes)}</dd></div>
                  <div className="col-span-2"><dt className="text-muted">Actual service time</dt><dd className="font-semibold">{minutes(a.utilization.actual_service_minutes)}</dd></div>
                </dl>
              </div>
              {a.heatmap.length > 0 && <div className="mt-6"><div className="eyebrow mb-2">When chairs are full</div><Heatmap cells={a.heatmap} /></div>}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Bookings" />
          <dl className="space-y-2 p-5 text-sm tnum">
            {[['Total', a.bookings.total], ['Completed', a.bookings.completed], ['Upcoming', a.bookings.upcoming], ['Cancelled', a.bookings.cancelled], ['  late', a.bookings.late_cancellations], ['No-shows', a.bookings.no_shows], ['Rescheduled', a.bookings.rescheduled], ['Online', a.bookings.online], ['Walk-ins', a.bookings.walk_ins], ['Staff / phone', a.bookings.staff], ['From waitlist', a.bookings.from_waitlist]].map(([k, v]) => (
              <div key={k as string} className={cx('flex justify-between', (k as string).startsWith('  ') && 'pl-3 text-muted')}><dt className="text-muted">{(k as string).trim()}</dt><dd className="font-medium">{v}</dd></div>
            ))}
            <div className="flex justify-between border-t border-line pt-2"><dt className="text-muted">Avg lead time</dt><dd className="font-medium">{a.bookings.avg_lead_time_hours !== null ? `${a.bookings.avg_lead_time_hours} h` : '—'}</dd></div>
            {a.bookings.funnel?.view ? (
              <div className="flex justify-between"><dt className="text-muted">Booking page conversion</dt><dd className="font-medium">{pct(((a.bookings.funnel.booked ?? 0) / a.bookings.funnel.view) * 100, 1)}</dd></div>
            ) : null}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Peak hours" />
          <div className="p-4">{a.bookings.peak_hours.length ? <ColumnChart ariaLabel="Appointments by start hour" height={170} data={a.bookings.peak_hours.map((h) => ({ label: hourLabel(h.hour), value: h.count, sub: `${hourLabel(h.hour)} · ${h.count} appts` }))} format={(v) => String(Math.round(v))} /> : <p className="text-sm text-muted">No bookings yet.</p>}</div>
        </Card>
        <Card>
          <CardHeader title="Peak days" />
          <div className="p-4">{a.bookings.peak_days.length ? <ColumnChart ariaLabel="Appointments by weekday" height={170} data={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ label: WEEKDAY_SHORT[d], value: a.bookings.peak_days.find((x) => x.dow === d)?.count ?? 0 }))} format={(v) => String(Math.round(v))} /> : <p className="text-sm text-muted">No bookings yet.</p>}</div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Clients" subtitle="New vs returning, retention health" />
          <div className="grid grid-cols-3 gap-4 p-5">
            <Stat label="Served" value={a.clients.served} />
            <Stat label="New" value={a.clients.new} />
            <Stat label="Returning" value={a.clients.returning} />
          </div>
          {a.clients.served > 0 && (
            <div className="px-5">
              <div className="flex h-3 overflow-hidden rounded-full">
                <div style={{ width: `${(a.clients.new / a.clients.served) * 100}%`, background: 'var(--series-1)' }} />
                <div className="ml-0.5 flex-1" style={{ background: 'var(--series-2)' }} />
              </div>
              <div className="mt-2"><Legend items={[{ label: `New ${pct((a.clients.new / a.clients.served) * 100)}`, color: 'var(--series-1)' }, { label: `Returning ${pct((a.clients.returning / a.clients.served) * 100)}`, color: 'var(--series-2)' }]} /></div>
            </div>
          )}
          <div className="grid grid-cols-4 gap-2 p-5 text-center text-sm">
            {(['NEW', 'ACTIVE', 'AT_RISK', 'LOST'] as const).map((h) => (
              <div key={h} className="rounded-xl bg-surface-2 p-3"><div className="text-lg font-semibold tnum">{a.clients.health[h] ?? 0}</div><div className="text-[11px] uppercase tracking-wider text-muted">{h.replace('_', ' ')}</div></div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Reviews" subtitle={a.reviews.all_time_average ? `All-time ★ ${a.reviews.all_time_average}` : undefined} />
          {!a.reviews.count ? <EmptyState title="No reviews in this period" body="Review requests go out automatically after each completed cut." /> : (
            <div className="p-5">
              <div className="flex items-baseline gap-3"><span className="text-4xl font-semibold tnum">{a.reviews.average}</span><Star className="size-6 fill-accent text-accent" /><span className="text-muted">{a.reviews.count} reviews</span></div>
              <div className="mt-4 space-y-1.5">
                {[5, 4, 3, 2, 1].map((n) => {
                  const c = a.reviews.distribution[n] ?? 0
                  return <div key={n} className="flex items-center gap-2 text-xs"><span className="w-3">{n}</span><div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-accent" style={{ width: `${(c / a.reviews.count) * 100}%` }} /></div><span className="w-6 text-right tnum text-muted">{c}</span></div>
                })}
              </div>
              <ul className="mt-5 space-y-3">
                {a.reviews.recent.slice(0, 4).map((r) => <li key={r.id} className="text-sm"><span className="text-accent">{'★'.repeat(r.rating)}</span> {r.comment ?? <span className="text-muted">No comment</span>} <span className="text-xs text-muted">— {r.client_name}{r.barber_name ? `, ${r.barber_name}` : ''}</span></li>)}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function hourLabel(h: number) {
  return `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'p' : 'a'}`
}
