import Link from "next/link";
import { STATUS_LABEL } from "@/lib/format";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-bold tracking-tight">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-ink" aria-hidden>
        ✂
      </span>
      Autocoti
    </Link>
  );
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-warn-soft text-warn",
  confirmed: "bg-good-soft text-good",
  completed: "bg-surface-2 text-ink-2",
  rejected: "bg-bad-soft text-bad",
  cancelled: "bg-bad-soft text-bad",
  no_show: "bg-bad-soft text-bad",
};
const STATUS_ICON: Record<string, string> = {
  pending: "⏳",
  confirmed: "✓",
  completed: "✓",
  rejected: "✕",
  cancelled: "✕",
  no_show: "!",
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip ${STATUS_STYLE[status] ?? ""}`}>
      <span aria-hidden className="mr-1">
        {STATUS_ICON[status]}
      </span>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Notice({ kind, children }: { kind: "error" | "ok"; children: React.ReactNode }) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-xl px-3 py-2 text-sm ${kind === "error" ? "bg-bad-soft text-bad" : "bg-good-soft text-good"}`}
    >
      {children}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}
