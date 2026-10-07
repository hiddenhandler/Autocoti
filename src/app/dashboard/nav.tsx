"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function DashNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:pb-0">
      {items.map((i) => {
        const active = i.href === "/dashboard" ? path === i.href : path.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${
              active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
