import { requireOwner } from "@/lib/auth";
import { money } from "@/lib/format";
import { resolveRange } from "@/lib/ranges";
import { shopAnalytics } from "@/lib/stats";
import { formatTime, minutesToHHMM, todayInTz, WEEKDAYS, WEEKDAYS_SHORT } from "@/lib/time";
import { BarChart, Heatmap } from "@/components/charts";
import { RangeTabs } from "@/components/range-tabs";
import { Stat } from "@/components/ui";

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const mins = (x: number | null) => (x == null ? "—" : `${Math.round(x)} min`);

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { shop } = await requireOwner();
  const range = resolveRange((await searchParams).range, todayInTz(shop.timezone));
  const a = shopAnalytics(shop.id, range.from, range.to);

  // Trim the hour axis to when the shop actually sees clients (fallback 9–20).
  const busyHours = a.byHour.flatMap((v, h) => (v ? [h] : []));
  const firstHour = busyHours.length ? Math.min(...busyHours) : 9;
  const lastHour = busyHours.length ? Math.max(...busyHours) : 20;
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);
  const hourLabel = (h: number) => formatTime(minutesToHHMM(h * 60)).replace(":00", "");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">Shop insights</h1>
          <p className="muted">Traffic, timing and reliability across every chair.</p>
        </div>
        <RangeTabs active={range.key} />
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Clients served" value={String(a.completed)} hint={`${a.booked} booked in range`} />
        <Stat label="Avg cut time" value={mins(a.avgCutMin)} hint="from Start → Done taps" />
        <Stat label="No-show rate" value={pct(a.noShowRate)} hint={`${a.noShows} no-shows · ${a.cancelled} cancelled`} />
        <Stat label="Booked online" value={pct(a.onlineShare)} hint="vs walk-ins & phone" />
      </div>

      <Heatmap
        title="When clients come in"
        rows={ORDER.map((d) => WEEKDAYS_SHORT[d])}
        cols={hours.map(hourLabel)}
        values={ORDER.map((d) => hours.map((h) => a.heatmap[d][h]))}
        unit="visits"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <BarChart
          title="Busiest hours"
          format={(n) => `${n} visits`}
          bars={hours.map((h) => ({
            label: hourLabel(h),
            value: a.byHour[h],
            tooltip: `${hourLabel(h)}: ${a.byHour[h]} visits`,
            tick: hourLabel(h),
          }))}
        />
        <BarChart
          title="Busiest days"
          format={(n) => `${n} visits`}
          bars={ORDER.map((d) => ({
            label: WEEKDAYS[d],
            value: a.byWeekday[d],
            tooltip: `${WEEKDAYS[d]}: ${a.byWeekday[d]} visits`,
            tick: WEEKDAYS_SHORT[d],
          }))}
        />
      </div>

      <section className="card overflow-x-auto">
        <h2 className="h2">By barber</h2>
        <table className="mt-3 w-full min-w-[520px] text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-ink-2">
              <th className="py-2 font-medium">Barber</th>
              <th className="py-2 text-right font-medium">Clients</th>
              <th className="py-2 text-right font-medium">Avg cut</th>
              <th className="py-2 text-right font-medium">No-shows</th>
              <th className="py-2 text-right font-medium">Cancelled</th>
              <th className="py-2 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {a.barbers.map((b) => (
              <tr key={b.id} className="border-t border-line">
                <td className="py-2 font-medium">{b.name}</td>
                <td className="py-2 text-right">{b.completed}</td>
                <td className="py-2 text-right">{mins(b.avgCutMin)}</td>
                <td className="py-2 text-right">{b.noShows}</td>
                <td className="py-2 text-right">{b.cancelled}</td>
                <td className="py-2 text-right">
                  {b.revenueCents == null ? <span className="text-xs text-ink-3">private</span> : money(b.revenueCents, shop.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-3">Barbers choose whether to share their revenue in their settings.</p>
      </section>

      <section className="card">
        <h2 className="h2">Services</h2>
        <table className="mt-3 w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-ink-2">
              <th className="py-2 font-medium">Service</th>
              <th className="py-2 text-right font-medium">Done</th>
              <th className="py-2 text-right font-medium">Avg time</th>
            </tr>
          </thead>
          <tbody>
            {a.services.map((s) => (
              <tr key={s.name} className="border-t border-line">
                <td className="py-2">{s.name}</td>
                <td className="py-2 text-right">{s.count}</td>
                <td className="py-2 text-right">{mins(s.avgMin)}</td>
              </tr>
            ))}
            {a.services.length === 0 && <tr><td className="py-2 text-ink-3">No completed cuts in this range.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
