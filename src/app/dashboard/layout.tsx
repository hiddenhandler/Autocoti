import { requireUser } from "@/lib/auth";
import { Logo } from "@/components/ui";
import { logout } from "../auth-actions";
import { DashNav } from "./nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, shop } = await requireUser();
  const isOwner = user.role === "owner";
  const items = [
    ...(user.has_chair
      ? [
          { href: "/dashboard", label: "Agenda" },
          { href: "/dashboard/finances", label: "My money" },
          { href: "/dashboard/services", label: "Services" },
          { href: "/dashboard/schedule", label: "Hours" },
        ]
      : []),
    ...(isOwner
      ? [
          { href: "/dashboard/analytics", label: "Shop insights" },
          { href: "/dashboard/team", label: "Team" },
          { href: "/dashboard/shop", label: "Shop settings" },
        ]
      : []),
    { href: "/dashboard/settings", label: "My settings" },
  ];

  return (
    <div className="min-h-dvh md:flex">
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-dvh md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-3 md:block md:py-5">
          <Logo href="/dashboard" />
          <div className="text-right md:mt-4 md:text-left">
            <div className="text-sm font-semibold">{shop.name}</div>
            <div className="text-xs text-ink-2">
              {user.name} · {isOwner ? "Owner" : "Barber"}
            </div>
          </div>
        </div>
        <DashNav items={items} />
        <div className="hidden px-3 pt-4 md:block">
          <a href={`/s/${shop.slug}`} target="_blank" className="btn-ghost btn-sm w-full">
            Open booking page ↗
          </a>
          <form action={logout} className="mt-2">
            <button className="btn-sm w-full rounded-xl text-ink-2 hover:text-ink">Log out</button>
          </form>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
