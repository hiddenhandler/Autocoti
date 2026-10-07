import crypto from "node:crypto";
import { computeSlots, rangesOverlap, type Range } from "./availability";
import { getDb, USER_COLUMNS, type Appointment, type Service, type Shop, type User } from "./db";
import { addDays, addMinutes, isValidDate, nowInTz, todayInTz } from "./time";

// Pending requests hold the slot too, so two clients can't ask for the same time.
export const BLOCKING_STATUSES = ["pending", "confirmed", "completed"] as const;

export function getShopBySlug(slug: string): Shop | undefined {
  return getDb().prepare("SELECT * FROM shops WHERE slug = ?").get(slug) as Shop | undefined;
}

export function getShop(id: number): Shop {
  return getDb().prepare("SELECT * FROM shops WHERE id = ?").get(id) as Shop;
}

/** Barbers clients can book: active and working a chair. */
export function getBookableBarbers(shopId: number): User[] {
  return getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE shop_id = ? AND active = 1 AND has_chair = 1 ORDER BY name`)
    .all(shopId) as User[];
}

export function getBarber(shopId: number, barberId: number): User | undefined {
  return getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND shop_id = ?`)
    .get(barberId, shopId) as User | undefined;
}

export function getServices(barberId: number, includeInactive = false): Service[] {
  return getDb()
    .prepare(
      `SELECT * FROM services WHERE barber_id = ? ${includeInactive ? "" : "AND active = 1"} ORDER BY price_cents, name`,
    )
    .all(barberId) as Service[];
}

function busyRanges(barberId: number, date: string): Range[] {
  const db = getDb();
  const dayStart = `${date} 00:00`;
  const dayEnd = `${addDays(date, 1)} 00:00`;
  const appts = db
    .prepare(
      `SELECT start_at AS start, end_at AS end FROM appointments
       WHERE barber_id = ? AND status IN (${BLOCKING_STATUSES.map(() => "?").join(",")})
       AND start_at < ? AND end_at > ?`,
    )
    .all(barberId, ...BLOCKING_STATUSES, dayEnd, dayStart) as Range[];
  const off = db
    .prepare(`SELECT start_at AS start, end_at AS end FROM time_off WHERE barber_id = ? AND start_at < ? AND end_at > ?`)
    .all(barberId, dayEnd, dayStart) as Range[];
  return [...appts, ...off];
}

export function getSlots(shop: Shop, barberId: number, durationMin: number, date: string, now = new Date()): string[] {
  if (!isValidDate(date)) return [];
  const today = todayInTz(shop.timezone, now);
  if (date < today || date > addDays(today, shop.max_days_ahead)) return [];
  const hours = getDb()
    .prepare("SELECT weekday, start_min, end_min FROM working_hours WHERE barber_id = ?")
    .all(barberId) as { weekday: number; start_min: number; end_min: number }[];
  return computeSlots({
    date,
    durationMin,
    intervalMin: shop.slot_interval_min,
    hours,
    busy: busyRanges(barberId, date),
    earliest: addMinutes(nowInTz(shop.timezone, now), shop.min_notice_min),
  });
}

export type BookingRequest = {
  shopSlug: string;
  barberId: number;
  serviceId: number;
  date: string;
  time: string; // HH:MM
  clientName: string;
  clientPhone: string;
  clientNote?: string;
};

export type BookingResult = { ok: true; token: string; status: "pending" | "confirmed" } | { ok: false; error: string };

export function createBooking(req: BookingRequest, now = new Date()): BookingResult {
  const db = getDb();
  const name = req.clientName.trim();
  const phone = req.clientPhone.trim();
  if (name.length < 2) return { ok: false, error: "Please enter your name." };
  if (phone.replace(/\D/g, "").length < 7) return { ok: false, error: "Please enter a valid phone number." };

  const shop = getShopBySlug(req.shopSlug);
  if (!shop) return { ok: false, error: "Shop not found." };
  const barber = getBookableBarbers(shop.id).find((b) => b.id === req.barberId);
  if (!barber) return { ok: false, error: "That barber is not taking bookings." };
  const service = getServices(barber.id).find((s) => s.id === req.serviceId);
  if (!service) return { ok: false, error: "That service is not available." };

  const token = crypto.randomBytes(16).toString("base64url");
  const status = barber.requires_approval ? "pending" : "confirmed";

  // better-sqlite3 transactions are synchronous, so the availability check and
  // the insert can't interleave with another request.
  const book = db.transaction((): BookingResult => {
    const slots = getSlots(shop, barber.id, service.duration_min, req.date, now);
    if (!slots.includes(req.time)) return { ok: false, error: "That time was just taken. Please pick another one." };
    const start = `${req.date} ${req.time}`;
    db.prepare(
      `INSERT INTO appointments (shop_id, barber_id, service_id, service_name, client_name, client_phone, client_note,
         start_at, end_at, status, source, quoted_cents, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
    ).run(
      shop.id,
      barber.id,
      service.id,
      service.name,
      name.slice(0, 80),
      phone.slice(0, 30),
      (req.clientNote ?? "").trim().slice(0, 300),
      start,
      addMinutes(start, service.duration_min),
      status,
      service.price_cents,
      token,
    );
    return { ok: true, token, status };
  });
  return book();
}

export type AppointmentView = Appointment & { barber_name: string; shop_name: string; shop_slug: string; shop_address: string };

export function getAppointmentByToken(token: string): AppointmentView | undefined {
  return getDb()
    .prepare(
      `SELECT a.*, u.name AS barber_name, s.name AS shop_name, s.slug AS shop_slug, s.address AS shop_address
       FROM appointments a JOIN users u ON u.id = a.barber_id JOIN shops s ON s.id = a.shop_id
       WHERE a.token = ?`,
    )
    .get(token) as AppointmentView | undefined;
}

export function cancelByClient(token: string): boolean {
  const res = getDb()
    .prepare("UPDATE appointments SET status = 'cancelled' WHERE token = ? AND status IN ('pending','confirmed')")
    .run(token);
  return res.changes > 0;
}

// ---- Barber-side actions ----

export type BarberAction =
  | { type: "accept" }
  | { type: "reject" }
  | { type: "cancel" }
  | { type: "no_show" }
  | { type: "start" }
  | { type: "complete"; chargedCents: number; tipCents: number; paymentMethod: string };

const ALLOWED_FROM: Record<BarberAction["type"], Appointment["status"][]> = {
  accept: ["pending"],
  reject: ["pending"],
  cancel: ["pending", "confirmed"],
  no_show: ["confirmed"],
  start: ["confirmed"],
  complete: ["confirmed"],
};

export function applyBarberAction(barberId: number, appointmentId: number, action: BarberAction, timezone: string): boolean {
  const db = getDb();
  const appt = db
    .prepare("SELECT * FROM appointments WHERE id = ? AND barber_id = ?")
    .get(appointmentId, barberId) as Appointment | undefined;
  if (!appt || !ALLOWED_FROM[action.type].includes(appt.status)) return false;
  const now = nowInTz(timezone);

  switch (action.type) {
    case "accept":
      db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(appt.id);
      break;
    case "reject":
      db.prepare("UPDATE appointments SET status = 'rejected' WHERE id = ?").run(appt.id);
      break;
    case "cancel":
      db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appt.id);
      break;
    case "no_show":
      db.prepare("UPDATE appointments SET status = 'no_show' WHERE id = ?").run(appt.id);
      break;
    case "start":
      db.prepare("UPDATE appointments SET started_at = ? WHERE id = ?").run(now, appt.id);
      break;
    case "complete":
      if (action.chargedCents < 0 || action.tipCents < 0) return false;
      db.prepare(
        `UPDATE appointments SET status = 'completed', charged_cents = ?, tip_cents = ?, payment_method = ?,
           started_at = COALESCE(started_at, start_at), finished_at = ? WHERE id = ?`,
      ).run(action.chargedCents, action.tipCents, action.paymentMethod, now, appt.id);
      break;
  }
  return true;
}

/** A walk-in or phone booking the barber enters themselves; skips the approval step. */
export function createWalkIn(
  shop: Shop,
  barberId: number,
  input: { serviceId: number; clientName: string; clientPhone: string; date: string; time: string },
): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const service = getServices(barberId).find((s) => s.id === input.serviceId);
  if (!service) return { ok: false, error: "Pick a service." };
  if (!isValidDate(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return { ok: false, error: "Pick a date and time." };
  const start = `${input.date} ${input.time}`;
  const range = { start, end: addMinutes(start, service.duration_min) };
  return db.transaction(() => {
    if (busyRanges(barberId, input.date).some((b) => rangesOverlap(b, range)))
      return { ok: false as const, error: "That overlaps another appointment or time off." };
    db.prepare(
      `INSERT INTO appointments (shop_id, barber_id, service_id, service_name, client_name, client_phone,
         start_at, end_at, status, source, quoted_cents, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'walk_in', ?, ?)`,
    ).run(
      shop.id,
      barberId,
      service.id,
      service.name,
      input.clientName.trim() || "Walk-in",
      input.clientPhone.trim(),
      range.start,
      range.end,
      service.price_cents,
      crypto.randomBytes(16).toString("base64url"),
    );
    return { ok: true as const };
  })();
}

export function getBarberDay(barberId: number, date: string): Appointment[] {
  return getDb()
    .prepare(
      `SELECT * FROM appointments WHERE barber_id = ? AND start_at >= ? AND start_at < ?
       AND status NOT IN ('rejected') ORDER BY start_at`,
    )
    .all(barberId, `${date} 00:00`, `${addDays(date, 1)} 00:00`) as Appointment[];
}

export function getPendingRequests(barberId: number, fromLocal: string): Appointment[] {
  return getDb()
    .prepare(`SELECT * FROM appointments WHERE barber_id = ? AND status = 'pending' AND start_at >= ? ORDER BY start_at`)
    .all(barberId, fromLocal) as Appointment[];
}
