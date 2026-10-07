import Link from "next/link";
import { notFound } from "next/navigation";
import { getBookableBarbers, getServices, getShopBySlug } from "@/lib/booking";
import { money } from "@/lib/format";
import { Logo } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const shop = getShopBySlug((await params).slug);
  return { title: shop ? `Book at ${shop.name}` : "Shop not found" };
}

export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const shop = getShopBySlug((await params).slug);
  if (!shop) notFound();
  const barbers = getBookableBarbers(shop.id).map((b) => ({ ...b, services: getServices(b.id) }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Logo />
      <header className="mt-8">
        <h1 className="h1">{shop.name}</h1>
        {shop.address && <p className="muted mt-1">{shop.address}</p>}
        <p className="mt-3 text-sm">Choose your barber to see open times.</p>
      </header>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {barbers.map((b) => {
          const prices = b.services.map((s) => s.price_cents);
          return (
            <li key={b.id}>
              <Link href={`/s/${shop.slug}/${b.id}`} className="card flex h-full flex-col hover:border-accent">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 place-items-center rounded-full bg-accent-soft text-lg font-bold text-accent">
                    {b.name.charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <div className="font-semibold">{b.name}</div>
                    <div className="text-xs text-ink-2">
                      {b.requires_approval ? "Confirms each request" : "Instant confirmation"}
                    </div>
                  </div>
                </div>
                {b.bio && <p className="mt-3 text-sm text-ink-2">{b.bio}</p>}
                <div className="mt-auto pt-3 text-sm">
                  {b.services.length ? (
                    <span>
                      {b.services.length} service{b.services.length > 1 ? "s" : ""} · from{" "}
                      <b>{money(Math.min(...prices), shop.currency)}</b>
                    </span>
                  ) : (
                    <span className="text-ink-3">No services listed yet</span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
        {barbers.length === 0 && <li className="card muted">No barbers are taking bookings right now.</li>}
      </ul>
    </main>
  );
}
