export function money(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(
    cents / 100,
  );
}

/** Parses "25", "25.50", "$25" into cents; returns null for anything else. */
export function parseMoney(input: FormDataEntryValue | null): number | null {
  const s = String(input ?? "").replace(/[$,\s]/g, "");
  if (s === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export const PAYMENT_METHODS = ["cash", "card", "transfer", "other"] as const;

export const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for approval",
  confirmed: "Confirmed",
  rejected: "Declined",
  cancelled: "Cancelled",
  completed: "Done",
  no_show: "No-show",
};
export const EXPENSE_CATEGORIES = ["Chair rent", "Products", "Tools", "Supplies", "Other"];
