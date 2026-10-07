import Link from "next/link";
import { notFound } from "next/navigation";
import { getBookableBarbers, getServices, getShopBySlug, getSlots } from "@/lib/booking";
import { money } from "@/lib/format";
import { addDays, formatDateLong, formatTime, todayInTz, WEEKDAYS_SHORT, weekdayOf } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Logo } from "@/components/ui";
import { book } from "../../actions";

type Search = { service?: string; date?: string; time?: string };

export default async function BarberBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; barberId: string }>;
  searchParams: Promise<Search>;
}) {
  const { slug, barberId } = await params;
  const sp = await searchParams;
  const shop = getShopBySlug(slug);
  if (!shop) notFound();
  const barber = getBookableBarbers(shop.id).find((b) => b.id === Number(barberId));
  if (!barber) notFound();

  const services = getServices(barber.id);
  const service = services.find((s) => s.id === Number(sp.service));
  const today = todayInTz(shop.timezone);
  const days = Array.from({ length: shop.max_days_ahead + 1 }, (_, i) => addDays(today, i));
  const base = `/s/${shop.slug}/${barber.id}`;
  const q = (p: Record<string, string | number>) => `${base}?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)]))}`;

  const dayCounts = service ? days.map((d) => ({ date: d, open: getSlots(shop, barber.id, service.duration_min, d).length })) : [];
  const date = service && sp.date && days.includes(sp.date) ? sp.date : undefined;
  const slots = service && date ? getSlots(shop, barber.id, service.duration_min, date) : [];
  const time = date && sp.time && slots.includes(sp.time) ? sp.time : undefined;

  const groups = [
    ["Morning", slots.filter((s) => s < "12:00")],
    ["Afternoon", slots.filter((s) => s >= "12:00" && s < "17:00")],
    ["Evening", slots.filter((s) => s >= "17:00")],
  ] as const;

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Logo />
      <Link href={`/s/${shop.slug}`} className="mt-6 inline-block text-sm text-ink-2 hover:text-ink">
        ← {shop.name}
      </Link>
      <header className="mt-2 flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-xl font-bold text-accent">
          {barber.name.charAt(0).toUpperCase()}
        </span>
        <div>
          <h1 className="h1">{barber.name}</h1>
          <p className="muted">{barber.requires_approval ? "Reviews each request before confirming" : "Bookings are confirmed instantly"}</p>
        </div>
      </header>

      <section className="mt-6">
        <h2 className="h2">1. Service</h2>
        <ul className="mt-3 grid gap-2">
          {services.map((s) => {
            const active = s.id === service?.id;
            return (
              <li key={s.id}>
                <Link
                  href={q({ service: s.id, ...(date ? { date } : {}) })}
                  className={`card flex items-center justify-between py-3 ${active ? "border-accent ring-2 ring-accent/30" : "hover:border-accent"}`}
                  aria-current={active ? "true" : undefined}
                >
                  <span>
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-2 text-xs text-ink-2">{s.duration_min} min</span>
                  </span>
                  <span className="font-semibold tabular-nums">{money(s.price_cents, shop.currency)}</span>
                </Link>
              </li>
            );
          })}
          {services.length === 0 && <li className="card muted">This barber hasn&apos;t listed services yet.</li>}
        </ul>
      </section>

      {service && (
        <section className="mt-8">
          <h2 className="h2">2. Day</h2>
          <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-2">
            {dayCounts.map(({ date: d, open }) => {
              const active = d === date;
              const content = (
                <>
                  <span className="text-xs">{d === today ? "Today" : WEEKDAYS_SHORT[weekdayOf(d)]}</span>
                  <span className="text-lg font-bold">{Number(d.slice(8))}</span>
                  <span className="text-[11px]">{open ? `${open} open` : "Full"}</span>
                </>
              );
              const cls = `flex w-16 shrink-0 flex-col items-center rounded-xl border px-2 py-2 ${
                active ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface"
              }`;
              return open ? (
                <Link key={d} href={q({ service: service.id, date: d })} className={`${cls} hover:border-accent`}>
                  {content}
                </Link>
              ) : (
                <span key={d} className={`${cls} text-ink-3 opacity-60`} aria-disabled>
                  {content}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {service && date && (
        <section className="mt-6">
          <h2 className="h2">3. Time · {formatDateLong(date)}</h2>
          {slots.length === 0 && <p className="muted mt-2">No open times left this day.</p>}
          {groups.map(([label, list]) =>
            list.length ? (
              <div key={label} className="mt-3">
                <div className="text-xs font-medium text-ink-2">{label}</div>
                <div className="mt-1.5 grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {list.map((t) => (
                    <Link
                      key={t}
                      href={q({ service: service.id, date, time: t }) + "#confirm"}
                      className={`rounded-xl border py-2 text-center text-sm font-medium tabular-nums ${
                        t === time ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface hover:border-accent"
                      }`}
                    >
                      {formatTime(t)}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </section>
      )}

      {service && date && time && (
        <section id="confirm" className="mt-8 scroll-mt-4">
          <h2 className="h2">4. Your details</h2>
          <div className="card mt-3">
            <p className="text-sm">
              <b>{service.name}</b> with {barber.name} · {formatDateLong(date)} at <b>{formatTime(time)}</b> ·{" "}
              {money(service.price_cents, shop.currency)}
            </p>
            <ActionForm action={book} className="mt-4 space-y-3">
              <input type="hidden" name="shopSlug" value={shop.slug} />
              <input type="hidden" name="barberId" value={barber.id} />
              <input type="hidden" name="serviceId" value={service.id} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="time" value={time} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="clientName">Name</label>
                  <input className="input" id="clientName" name="clientName" autoComplete="name" required />
                </div>
                <div>
                  <label className="label" htmlFor="clientPhone">Phone</label>
                  <input className="input" id="clientPhone" name="clientPhone" type="tel" autoComplete="tel" required />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="clientNote">Note for your barber (optional)</label>
                <input className="input" id="clientNote" name="clientNote" maxLength={300} placeholder="e.g. skin fade, keep the top long" />
              </div>
              <SubmitButton className="btn-primary w-full sm:w-auto">
                {barber.requires_approval ? "Send request" : "Book it"}
              </SubmitButton>
            </ActionForm>
          </div>
        </section>
      )}
    </main>
  );
}
