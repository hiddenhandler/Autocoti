import Link from "next/link";
import { RANGES } from "@/lib/ranges";

export function RangeTabs({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1" aria-label="Date range">
      {RANGES.map((r) => (
        <Link
          key={r.key}
          href={`?range=${r.key}`}
          aria-current={r.key === active ? "true" : undefined}
          className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${
            r.key === active ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
          }`}
        >
          {r.label}
        </Link>
      ))}
    </nav>
  );
}
