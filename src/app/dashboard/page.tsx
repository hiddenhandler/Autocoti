import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getBarberDay, getPendingRequests, getServices } from "@/lib/booking";
import { money, PAYMENT_METHODS } from "@/lib/format";
import { addDays, formatDateLong, formatTime, isValidDate, nowInTz, todayInTz } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { StatusChip } from "@/components/ui";
import { addWalkIn, appointmentAction, completeAppointment } from "./actions";

export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { user, shop } = await requireUser();
  if (!user.has_chair) redirect("/dashboard/analytics");
  const today = todayInTz(shop.timezone);
  const sp = await searchParams;
  const date = sp.date && isValidDate(sp.date) ? sp.date : today;
  const now = nowInTz(shop.timezone);

  const pending = getPendingRequests(user.id, now);
  const day = getBarberDay(user.id, date);
  const services = getServices(user.id);
  const earned = day.filter((a) => a.status === "completed").reduce((s, a) => s + (a.charged_cents ?? 0) + a.tip_cents, 0);
  const upcoming = day.filter((a) => a.status === "confirmed").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">{date === today ? "Today" : formatDateLong(date)}</h1>
          <p className="muted">
            {upcoming} booked · {money(earned, shop.currency)} earned
          </p>
        </div>
        <nav className="flex gap-2" aria-label="Change day">
          <Link className="btn-ghost btn-sm" href={`?date=${addDays(date, -1)}`} aria-label="Previous day">←</Link>
          {date !== today && <Link className="btn-ghost btn-sm" href="/dashboard">Today</Link>}
          <Link className="btn-ghost btn-sm" href={`?date=${addDays(date, 1)}`} aria-label="Next day">→</Link>
        </nav>
      </header>

      {pending.length > 0 && (
        <section className="card border-warn/40">
          <h2 className="h2">Requests waiting for you ({pending.length})</h2>
          <ul className="mt-3 divide-y divide-line">
            {pending.slice(0, 10).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="text-sm">
                  <div className="font-semibold">
                    {formatDateLong(a.start_at.slice(0, 10))} · {formatTime(a.start_at)}
                  </div>
                  <div className="text-ink-2">
                    {a.client_name} · {a.service_name}
                    {a.client_phone && (
                      <> · <a className="underline" href={`tel:${a.client_phone}`}>{a.client_phone}</a></>
                    )}
                  </div>
                  {a.client_note && <div className="mt-0.5 text-ink-3">“{a.client_note}”</div>}
                </div>
                <div className="flex gap-2">
                  <form action={appointmentAction.bind(null, a.id, "reject")}>
                    <button className="btn-ghost btn-sm">Decline</button>
                  </form>
                  <form action={appointmentAction.bind(null, a.id, "accept")}>
                    <button className="btn-primary btn-sm">Accept</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          {pending.length > 10 && (
            <p className="mt-2 text-xs text-ink-3">Showing the 10 soonest. Handle these and the rest will appear.</p>
          )}
        </section>
      )}

      <section className="space-y-3">
        {day.length === 0 && <div className="card muted">Nothing booked for this day.</div>}
        {day.map((a) => (
          <article key={a.id} className={`card ${["cancelled", "no_show"].includes(a.status) ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {formatTime(a.start_at)} <span className="text-sm font-normal text-ink-3">– {formatTime(a.end_at)}</span>
                </div>
                <div className="font-medium">
                  {a.client_name}
                  {a.source === "walk_in" && <span className="chip ml-2 bg-surface-2 text-ink-2">walk-in</span>}
                </div>
                <div className="text-sm text-ink-2">
                  {a.service_name} · quoted {money(a.quoted_cents, shop.currency)}
                  {a.client_phone && (
                    <> · <a className="underline" href={`tel:${a.client_phone}`}>{a.client_phone}</a></>
                  )}
                </div>
                {a.client_note && <div className="mt-1 text-sm text-ink-3">“{a.client_note}”</div>}
              </div>
              <StatusChip status={a.status} />
            </div>

            {a.status === "completed" && (
              <p className="mt-3 text-sm">
                Charged <b>{money(a.charged_cents, shop.currency)}</b>
                {a.tip_cents > 0 && <> + {money(a.tip_cents, shop.currency)} tip</>} · {a.payment_method}
              </p>
            )}

            {a.status === "pending" && (
              <div className="mt-3 flex gap-2">
                <form action={appointmentAction.bind(null, a.id, "reject")}><button className="btn-ghost btn-sm">Decline</button></form>
                <form action={appointmentAction.bind(null, a.id, "accept")}><button className="btn-primary btn-sm">Accept</button></form>
              </div>
            )}

            {a.status === "confirmed" && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {!a.started_at ? (
                    <form action={appointmentAction.bind(null, a.id, "start")}>
                      <button className="btn-ghost btn-sm">▶ Start cut</button>
                    </form>
                  ) : (
                    <span className="chip bg-accent-soft text-accent">In the chair since {formatTime(a.started_at)}</span>
                  )}
                  <form action={appointmentAction.bind(null, a.id, "no_show")}>
                    <button className="btn-ghost btn-sm">No-show</button>
                  </form>
                  <form action={appointmentAction.bind(null, a.id, "cancel")}>
                    <button className="btn-ghost btn-sm text-bad">Cancel</button>
                  </form>
                </div>
                <details className="rounded-xl bg-surface-2 p-3" open={!!a.started_at}>
                  <summary className="cursor-pointer text-sm font-semibold">✓ Finish &amp; log payment</summary>
                  <ActionForm action={completeAppointment.bind(null, a.id)} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-end">
                    <div>
                      <label className="label" htmlFor={`charged-${a.id}`}>Charged</label>
                      <input className="input" id={`charged-${a.id}`} name="charged" inputMode="decimal" defaultValue={(a.quoted_cents / 100).toString()} />
                    </div>
                    <div>
                      <label className="label" htmlFor={`tip-${a.id}`}>Tip</label>
                      <input className="input" id={`tip-${a.id}`} name="tip" inputMode="decimal" placeholder="0" />
                    </div>
                    <div>
                      <label className="label" htmlFor={`method-${a.id}`}>Paid with</label>
                      <select className="input" id={`method-${a.id}`} name="method" defaultValue="cash">
                        {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <SubmitButton>Done</SubmitButton>
                  </ActionForm>
                </details>
              </div>
            )}
          </article>
        ))}
      </section>

      <details className="card">
        <summary className="cursor-pointer font-semibold">+ Add walk-in or phone booking</summary>
        <ActionForm action={addWalkIn} resetOnSuccess className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="wi-service">Service</label>
            <select className="input" id="wi-service" name="serviceId" required>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.duration_min} min</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="wi-name">Client name</label>
            <input className="input" id="wi-name" name="clientName" placeholder="Walk-in" />
          </div>
          <div>
            <label className="label" htmlFor="wi-date">Date</label>
            <input className="input" id="wi-date" name="date" type="date" defaultValue={date} required />
          </div>
          <div>
            <label className="label" htmlFor="wi-time">Time</label>
            <input className="input" id="wi-time" name="time" type="time" step={300} defaultValue={now.slice(11, 16)} required />
          </div>
          <div>
            <label className="label" htmlFor="wi-phone">Phone (optional)</label>
            <input className="input" id="wi-phone" name="clientPhone" type="tel" />
          </div>
          <div className="flex items-end">
            <SubmitButton className="btn-primary w-full">Add</SubmitButton>
          </div>
        </ActionForm>
      </details>
    </div>
  );
}
