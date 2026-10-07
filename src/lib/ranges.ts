import { addDays } from "./time";

export const RANGES = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "90d", label: "Last 90 days" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export function resolveRange(key: string | undefined, today: string): { key: RangeKey; from: string; to: string } {
  switch (key) {
    case "7d":
      return { key, from: addDays(today, -6), to: today };
    case "month":
      return { key, from: `${today.slice(0, 8)}01`, to: today };
    case "90d":
      return { key, from: addDays(today, -89), to: today };
    default:
      return { key: "30d", from: addDays(today, -29), to: today };
  }
}
