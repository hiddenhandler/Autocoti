// Helpers for shop-local wall-clock strings: "YYYY-MM-DD" and "YYYY-MM-DD HH:MM".
// Date math runs in UTC on naive values so the host timezone never leaks in.

const pad = (n: number) => String(n).padStart(2, "0");

export function nowInTz(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function todayInTz(timezone: string, at: Date = new Date()): string {
  return nowInTz(timezone, at).slice(0, 10);
}

function toUtc(local: string): Date {
  const [d, t = "00:00"] = local.split(" ");
  return new Date(`${d}T${t}:00Z`);
}

function fromUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
}

export function addMinutes(local: string, minutes: number): string {
  return fromUtc(new Date(toUtc(local).getTime() + minutes * 60_000));
}

export function addDays(date: string, days: number): string {
  return fromUtc(new Date(toUtc(date).getTime() + days * 86_400_000)).slice(0, 10);
}

export function diffMinutes(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 60_000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(date: string): number {
  return toUtc(date).getUTCDay();
}

export function minutesToHHMM(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(toUtc(date).getTime()) && fromUtc(toUtc(date)).startsWith(date);
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDateLong(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(
    toUtc(date),
  );
}

export function formatTime(local: string): string {
  const t = local.length > 5 ? local.slice(11, 16) : local;
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${pad(m)}${suffix}`;
}
