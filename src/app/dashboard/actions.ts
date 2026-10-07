"use server";

import { revalidatePath } from "next/cache";
import { createUser, emailTaken, setPassword, slugify } from "@/lib/accounts";
import { requireOwner, requireUser } from "@/lib/auth";
import { applyBarberAction, createWalkIn, type BarberAction } from "@/lib/booking";
import { getDb } from "@/lib/db";
import { EXPENSE_CATEGORIES, parseMoney, PAYMENT_METHODS } from "@/lib/format";
import { addDays, hhmmToMinutes, isValidDate } from "@/lib/time";
import type { ActionResult } from "@/components/action-form";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const int = (fd: FormData, k: string) => Number.parseInt(str(fd, k), 10);

// ---- Agenda ----

export async function appointmentAction(appointmentId: number, type: Exclude<BarberAction["type"], "complete">) {
  const { user, shop } = await requireUser();
  applyBarberAction(user.id, appointmentId, { type }, shop.timezone);
  revalidatePath("/dashboard");
}

export async function completeAppointment(appointmentId: number, fd: FormData): Promise<ActionResult> {
  const { user, shop } = await requireUser();
  const charged = parseMoney(fd.get("charged"));
  const tip = parseMoney(fd.get("tip"));
  const method = str(fd, "method");
  if (charged === null || tip === null) return { error: "Amounts must be numbers, like 25 or 25.50." };
  if (!PAYMENT_METHODS.includes(method as (typeof PAYMENT_METHODS)[number])) return { error: "Pick how they paid." };
  const ok = applyBarberAction(
    user.id,
    appointmentId,
    { type: "complete", chargedCents: charged, tipCents: tip, paymentMethod: method },
    shop.timezone,
  );
  if (!ok) return { error: "This appointment can't be completed anymore." };
  revalidatePath("/dashboard");
}

export async function addWalkIn(fd: FormData): Promise<ActionResult> {
  const { user, shop } = await requireUser();
  const res = createWalkIn(shop, user.id, {
    serviceId: int(fd, "serviceId"),
    clientName: str(fd, "clientName"),
    clientPhone: str(fd, "clientPhone"),
    date: str(fd, "date"),
    time: str(fd, "time"),
  });
  if (!res.ok) return { error: res.error };
  revalidatePath("/dashboard");
  return { ok: "Added to your agenda." };
}

// ---- Services ----

function readService(fd: FormData) {
  const name = str(fd, "name");
  const duration = int(fd, "duration");
  const price = parseMoney(fd.get("price"));
  if (!name) return { error: "Give the service a name." } as const;
  if (!(duration >= 5 && duration <= 480)) return { error: "Duration must be between 5 and 480 minutes." } as const;
  if (price === null) return { error: "Price must be a number, like 25 or 25.50." } as const;
  return { name: name.slice(0, 60), duration, price } as const;
}

export async function addService(fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const s = readService(fd);
  if ("error" in s) return { error: s.error };
  getDb()
    .prepare("INSERT INTO services (barber_id, name, duration_min, price_cents) VALUES (?, ?, ?, ?)")
    .run(user.id, s.name, s.duration, s.price);
  revalidatePath("/dashboard/services");
  return { ok: `${s.name} added.` };
}

export async function updateService(serviceId: number, fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const s = readService(fd);
  if ("error" in s) return { error: s.error };
  getDb()
    .prepare("UPDATE services SET name = ?, duration_min = ?, price_cents = ?, active = ? WHERE id = ? AND barber_id = ?")
    .run(s.name, s.duration, s.price, fd.get("active") === "on" ? 1 : 0, serviceId, user.id);
  revalidatePath("/dashboard/services");
  return { ok: "Saved." };
}

// ---- Working hours & time off ----

export async function saveHours(fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const rows: { weekday: number; start: number; end: number }[] = [];
  for (let wd = 0; wd < 7; wd++) {
    if (fd.get(`on-${wd}`) !== "on") continue;
    for (const [s, e] of [
      [`start-${wd}`, `end-${wd}`],
      [`start2-${wd}`, `end2-${wd}`],
    ]) {
      const start = str(fd, s);
      const end = str(fd, e);
      if (!start && !end) continue;
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return { error: "Each shift needs a start and end time." };
      const [a, b] = [hhmmToMinutes(start), hhmmToMinutes(end)];
      if (b <= a) return { error: "A shift has to end after it starts." };
      rows.push({ weekday: wd, start: a, end: b });
    }
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM working_hours WHERE barber_id = ?").run(user.id);
    const ins = db.prepare("INSERT INTO working_hours (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)");
    for (const r of rows) ins.run(user.id, r.weekday, r.start, r.end);
  })();
  revalidatePath("/dashboard/schedule");
  return { ok: "Hours saved. Clients see the new times right away." };
}

export async function addTimeOff(fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const from = str(fd, "from");
  const to = str(fd, "to") || from;
  const allDay = fd.get("allDay") === "on";
  const startT = allDay ? "00:00" : str(fd, "startTime");
  const endT = allDay ? "00:00" : str(fd, "endTime");
  if (!isValidDate(from) || !isValidDate(to) || to < from) return { error: "Pick a valid date range." };
  if (!/^\d{2}:\d{2}$/.test(startT) || !/^\d{2}:\d{2}$/.test(endT)) return { error: "Pick start and end times, or mark it all day." };
  const start = `${from} ${startT}`;
  // All-day blocks run to midnight at the end of the last day.
  const end = allDay ? `${addDays(to, 1)} 00:00` : `${to} ${endT}`;
  if (end <= start) return { error: "Time off has to end after it starts." };
  getDb()
    .prepare("INSERT INTO time_off (barber_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)")
    .run(user.id, start, end, str(fd, "reason").slice(0, 80));
  revalidatePath("/dashboard/schedule");
  return { ok: "Blocked. Existing bookings in that window are kept — cancel them from your agenda if needed." };
}

export async function deleteTimeOff(id: number) {
  const { user } = await requireUser();
  getDb().prepare("DELETE FROM time_off WHERE id = ? AND barber_id = ?").run(id, user.id);
  revalidatePath("/dashboard/schedule");
}

// ---- Finances ----

export async function addExpense(fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const amount = parseMoney(fd.get("amount"));
  const date = str(fd, "date");
  if (!amount) return { error: "Enter an amount." };
  if (!isValidDate(date)) return { error: "Pick a date." };
  const category = EXPENSE_CATEGORIES.includes(str(fd, "category")) ? str(fd, "category") : "Other";
  getDb()
    .prepare("INSERT INTO expenses (barber_id, date, amount_cents, category, note) VALUES (?, ?, ?, ?, ?)")
    .run(user.id, date, amount, category, str(fd, "note").slice(0, 120));
  revalidatePath("/dashboard/finances");
  return { ok: "Expense saved." };
}

export async function deleteExpense(id: number) {
  const { user } = await requireUser();
  getDb().prepare("DELETE FROM expenses WHERE id = ? AND barber_id = ?").run(id, user.id);
  revalidatePath("/dashboard/finances");
}

// ---- Personal settings ----

export async function saveProfile(fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const name = str(fd, "name");
  if (name.length < 2) return { error: "Name is required." };
  getDb()
    .prepare("UPDATE users SET name = ?, bio = ?, requires_approval = ?, share_earnings = ? WHERE id = ?")
    .run(name, str(fd, "bio").slice(0, 200), fd.get("requiresApproval") === "on" ? 1 : 0, fd.get("shareEarnings") === "on" ? 1 : 0, user.id);
  revalidatePath("/dashboard", "layout");
  return { ok: "Saved." };
}

export async function changePassword(fd: FormData): Promise<ActionResult> {
  const { user } = await requireUser();
  const pw = String(fd.get("password") ?? "");
  if (pw.length < 8) return { error: "Password must be at least 8 characters." };
  setPassword(user.id, pw);
  return { ok: "Password changed." };
}

// ---- Owner: team & shop ----

export async function addBarber(fd: FormData): Promise<ActionResult> {
  const { shop } = await requireOwner();
  const name = str(fd, "name");
  const email = str(fd, "email");
  const password = String(fd.get("password") ?? "");
  if (name.length < 2) return { error: "Name is required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email." };
  if (password.length < 8) return { error: "Temporary password must be at least 8 characters." };
  if (emailTaken(email)) return { error: "That email is already in use." };
  createUser({ shopId: shop.id, name, email, password, role: "barber", hasChair: true });
  revalidatePath("/dashboard/team");
  return { ok: `${name} added. Share their email and temporary password so they can log in.` };
}

export async function updateMember(memberId: number, field: "has_chair" | "active", value: boolean) {
  const { user, shop } = await requireOwner();
  // Owners can't lock themselves out.
  if (memberId === user.id && field === "active") return;
  getDb().prepare(`UPDATE users SET ${field} = ? WHERE id = ? AND shop_id = ?`).run(value ? 1 : 0, memberId, shop.id);
  if (field === "active" && !value) getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(memberId);
  revalidatePath("/dashboard/team");
}

export async function saveShop(fd: FormData): Promise<ActionResult> {
  const { shop } = await requireOwner();
  const name = str(fd, "name");
  const slug = slugify(str(fd, "slug"));
  const timezone = str(fd, "timezone");
  const interval = int(fd, "interval");
  const notice = int(fd, "notice");
  const ahead = int(fd, "ahead");
  if (name.length < 2) return { error: "Shop name is required." };
  if (slug.length < 2) return { error: "Link name needs at least 2 letters or numbers." };
  if (getDb().prepare("SELECT 1 FROM shops WHERE slug = ? AND id != ?").get(slug, shop.id))
    return { error: "That link is taken. Try another." };
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return { error: "Unknown time zone." };
  }
  if (![5, 10, 15, 20, 30, 60].includes(interval)) return { error: "Pick a slot interval." };
  if (!(notice >= 0 && notice <= 2880)) return { error: "Minimum notice must be 0–2880 minutes." };
  if (!(ahead >= 1 && ahead <= 120)) return { error: "Booking window must be 1–120 days." };
  getDb()
    .prepare(
      `UPDATE shops SET name = ?, slug = ?, address = ?, phone = ?, timezone = ?, currency = ?,
         slot_interval_min = ?, min_notice_min = ?, max_days_ahead = ? WHERE id = ?`,
    )
    .run(name, slug, str(fd, "address").slice(0, 120), str(fd, "phone").slice(0, 30), timezone, str(fd, "currency") || shop.currency, interval, notice, ahead, shop.id);
  revalidatePath("/dashboard", "layout");
  return { ok: "Shop updated." };
}
