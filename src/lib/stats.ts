import { getDb, type Appointment, type Expense, type User, USER_COLUMNS } from "./db";
import { addDays, diffMinutes, weekdayOf } from "./time";

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Actual chair time when the barber tapped Start/Finish, else the scheduled length. */
export function cutMinutes(a: Appointment): number {
  if (a.started_at && a.finished_at) {
    const m = diffMinutes(a.started_at, a.finished_at);
    if (m > 0 && m < 8 * 60) return m;
  }
  return diffMinutes(a.start_at, a.end_at);
}

function appointmentsBetween(where: string, id: number, from: string, to: string): Appointment[] {
  return getDb()
    .prepare(`SELECT * FROM appointments WHERE ${where} = ? AND start_at >= ? AND start_at < ? ORDER BY start_at`)
    .all(id, `${from} 00:00`, `${addDays(to, 1)} 00:00`) as Appointment[];
}

export type Finances = {
  completed: number;
  revenueCents: number;
  tipsCents: number;
  expensesCents: number;
  netCents: number;
  avgTicketCents: number | null;
  daily: { date: string; cents: number; cuts: number }[];
  byService: { name: string; count: number; cents: number }[];
  byMethod: { method: string; count: number; cents: number }[];
  expenses: Expense[];
};

export function barberFinances(barberId: number, from: string, to: string): Finances {
  const done = appointmentsBetween("barber_id", barberId, from, to).filter((a) => a.status === "completed");
  const expenses = getDb()
    .prepare("SELECT * FROM expenses WHERE barber_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC")
    .all(barberId, from, to) as Expense[];

  const daily = new Map<string, { cents: number; cuts: number }>();
  for (let d = from; d <= to; d = addDays(d, 1)) daily.set(d, { cents: 0, cuts: 0 });
  const byService = new Map<string, { count: number; cents: number }>();
  const byMethod = new Map<string, { count: number; cents: number }>();

  let revenue = 0;
  let tips = 0;
  for (const a of done) {
    const charged = a.charged_cents ?? 0;
    revenue += charged;
    tips += a.tip_cents;
    const day = daily.get(a.start_at.slice(0, 10));
    if (day) {
      day.cents += charged + a.tip_cents;
      day.cuts += 1;
    }
    const s = byService.get(a.service_name) ?? { count: 0, cents: 0 };
    s.count += 1;
    s.cents += charged;
    byService.set(a.service_name, s);
    const method = a.payment_method || "other";
    const m = byMethod.get(method) ?? { count: 0, cents: 0 };
    m.count += 1;
    m.cents += charged + a.tip_cents;
    byMethod.set(method, m);
  }
  const expensesCents = expenses.reduce((sum, e) => sum + e.amount_cents, 0);

  return {
    completed: done.length,
    revenueCents: revenue,
    tipsCents: tips,
    expensesCents,
    netCents: revenue + tips - expensesCents,
    avgTicketCents: done.length ? Math.round(revenue / done.length) : null,
    daily: [...daily].map(([date, v]) => ({ date, ...v })),
    byService: [...byService].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cents - a.cents),
    byMethod: [...byMethod].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.cents - a.cents),
    expenses,
  };
}

export type BarberStat = {
  id: number;
  name: string;
  completed: number;
  noShows: number;
  cancelled: number;
  avgCutMin: number | null;
  revenueCents: number | null; // null when the barber keeps earnings private
};

export type ShopAnalytics = {
  booked: number;
  completed: number;
  noShows: number;
  cancelled: number;
  pending: number;
  onlineShare: number | null;
  avgCutMin: number | null;
  noShowRate: number | null;
  heatmap: number[][]; // [weekday][hour] visit counts
  byHour: number[]; // 24 entries
  byWeekday: number[]; // 7 entries
  barbers: BarberStat[];
  services: { name: string; count: number; avgMin: number }[];
};

/** Visits = clients who showed up or are booked to; drives the traffic charts. */
const VISIT_STATUSES = new Set(["completed", "confirmed"]);

export function shopAnalytics(shopId: number, from: string, to: string): ShopAnalytics {
  const appts = appointmentsBetween("shop_id", shopId, from, to);
  const team = getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE shop_id = ? ORDER BY name`).all(shopId) as User[];

  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const byHour = Array(24).fill(0) as number[];
  const byWeekday = Array(7).fill(0) as number[];
  const serviceDur = new Map<string, number[]>();
  const completed = appts.filter((a) => a.status === "completed");

  for (const a of appts) {
    if (!VISIT_STATUSES.has(a.status)) continue;
    const wd = weekdayOf(a.start_at.slice(0, 10));
    const hr = Number(a.start_at.slice(11, 13));
    heatmap[wd][hr] += 1;
    byHour[hr] += 1;
    byWeekday[wd] += 1;
  }
  for (const a of completed) {
    const list = serviceDur.get(a.service_name) ?? [];
    list.push(cutMinutes(a));
    serviceDur.set(a.service_name, list);
  }

  const count = (s: string) => appts.filter((a) => a.status === s).length;
  const noShows = count("no_show");
  const relevant = appts.filter((a) => a.status !== "rejected" && a.status !== "cancelled");
  const settled = completed.length + noShows;

  const barbers: BarberStat[] = team
    .filter((u) => u.has_chair || appts.some((a) => a.barber_id === u.id))
    .map((u) => {
      const mine = appts.filter((a) => a.barber_id === u.id);
      const done = mine.filter((a) => a.status === "completed");
      return {
        id: u.id,
        name: u.name,
        completed: done.length,
        noShows: mine.filter((a) => a.status === "no_show").length,
        cancelled: mine.filter((a) => a.status === "cancelled").length,
        avgCutMin: avg(done.map(cutMinutes)),
        revenueCents: u.share_earnings ? done.reduce((s, a) => s + (a.charged_cents ?? 0), 0) : null,
      };
    });

  return {
    booked: relevant.length,
    completed: completed.length,
    noShows,
    cancelled: count("cancelled"),
    pending: count("pending"),
    onlineShare: relevant.length ? relevant.filter((a) => a.source === "online").length / relevant.length : null,
    avgCutMin: avg(completed.map(cutMinutes)),
    noShowRate: settled ? noShows / settled : null,
    heatmap,
    byHour,
    byWeekday,
    barbers,
    services: [...serviceDur]
      .map(([name, mins]) => ({ name, count: mins.length, avgMin: avg(mins) ?? 0 }))
      .sort((a, b) => b.count - a.count),
  };
}
