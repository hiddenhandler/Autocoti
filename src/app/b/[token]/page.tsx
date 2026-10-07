import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppointmentByToken } from "@/lib/booking";
import { formatDateLong, formatTime } from "@/lib/time";
import { Logo, StatusChip } from "@/components/ui";
import { cancelBooking } from "../../s/actions";

export const metadata = { title: "Your booking", robots: { index: false } };

export default async function BookingStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { token } = await params;
  const isNew = (await searchParams).new === "1";
  const a = getAppointmentByToken(token);
  if (!a) notFound();
  const canCancel = a.status === "pending" || a.status === "confirmed";

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <Logo />
      {isNew && (
        <div className="mt-8 rounded-2xl bg-good-soft p-4 text-good">
          <div className="font-semibold">{a.status === "pending" ? "Request sent!" : "You're booked!"}</div>
          <div className="mt-1 text-sm">
            {a.status === "pending"
              ? `${a.barber_name} will confirm soon. Bookmark this page to check the status.`
              : "Bookmark this page — you can check or cancel your booking here."}
          </div>
        </div>
      )}
      <div className="card mt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm text-ink-2">{a.shop_name}</div>
            <h1 className="h1 mt-0.5">{a.service_name}</h1>
          </div>
          <StatusChip status={a.status} />
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-2">When</dt>
          <dd className="font-medium">
            {formatDateLong(a.start_at.slice(0, 10))}, {formatTime(a.start_at)} – {formatTime(a.end_at)}
          </dd>
          <dt className="text-ink-2">Barber</dt>
          <dd className="font-medium">{a.barber_name}</dd>
          {a.shop_address && (
            <>
              <dt className="text-ink-2">Where</dt>
              <dd className="font-medium">{a.shop_address}</dd>
            </>
          )}
          <dt className="text-ink-2">Name</dt>
          <dd className="font-medium">{a.client_name}</dd>
        </dl>
        {canCancel && (
          <form action={cancelBooking.bind(null, token)} className="mt-5">
            <button className="btn-ghost w-full text-bad">Cancel booking</button>
          </form>
        )}
      </div>
      <Link href={`/s/${a.shop_slug}`} className="btn-ghost mt-4 w-full">
        Book another visit
      </Link>
    </main>
  );
}
