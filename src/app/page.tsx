import Link from "next/link";
import { Logo } from "@/components/ui";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="flex items-center justify-between">
        <Logo />
        <nav className="flex gap-2">
          <Link href="/login" className="btn-ghost btn-sm">
            Log in
          </Link>
          <Link href="/signup" className="btn-primary btn-sm">
            Add your shop
          </Link>
        </nav>
      </header>

      <section className="py-16 sm:py-24">
        <p className="text-sm font-semibold text-accent">Stop calling. Start booking.</p>
        <h1 className="mt-2 max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          Your barber&apos;s open times, one tap away.
        </h1>
        <p className="mt-4 max-w-xl text-lg text-ink-2">
          Clients see exactly when each barber is free and grab a spot. Barbers decide whether bookings need their OK,
          log what they charge, and track their money. Owners see when the shop is busy.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/signup" className="btn-primary">
            Set up my barbershop
          </Link>
          <Link href="/s/demo" className="btn-ghost">
            Try the demo shop
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["For clients", "Pick a barber, a service and a free time. Get a link to check or cancel it. No account, no phone call."],
          ["For barbers", "Set your hours and prices, auto-confirm or approve each request, mark what you charged and see your earnings."],
          ["For owners", "Busiest hours and days, average cut time, no-shows and how each chair is doing — all in one place."],
        ].map(([t, d]) => (
          <div key={t} className="card">
            <h2 className="h2">{t}</h2>
            <p className="mt-1 muted">{d}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
