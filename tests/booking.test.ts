import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createShopWithOwner, createUser } from "../src/lib/accounts";
import { computeSlots } from "../src/lib/availability";
import { applyBarberAction, cancelByClient, createBooking, createWalkIn, getAppointmentByToken, getShop, getSlots } from "../src/lib/booking";
import { getDb, openDb, setDb } from "../src/lib/db";
import { barberFinances, shopAnalytics } from "../src/lib/stats";
import { addDays, nowInTz } from "../src/lib/time";

// Fixed "now": Monday 2026-10-05 08:00 in Mexico City (UTC-6).
const NOW = new Date("2026-10-05T14:00:00Z");
const MONDAY = "2026-10-05";

describe("computeSlots", () => {
  test("fits services inside shifts and skips busy ranges", () => {
    const slots = computeSlots({
      date: MONDAY,
      durationMin: 30,
      intervalMin: 30,
      hours: [{ weekday: 1, start_min: 600, end_min: 720 }],
      busy: [{ start: `${MONDAY} 10:30`, end: `${MONDAY} 11:00` }],
      earliest: `${MONDAY} 00:00`,
    });
    assert.deepEqual(slots, ["10:00", "11:00", "11:30"]);
  });

  test("respects the earliest bookable time", () => {
    const slots = computeSlots({
      date: MONDAY,
      durationMin: 60,
      intervalMin: 60,
      hours: [{ weekday: 1, start_min: 600, end_min: 780 }],
      busy: [],
      earliest: `${MONDAY} 11:00`,
    });
    assert.deepEqual(slots, ["11:00", "12:00"]);
  });

  test("returns nothing on a day off", () => {
    const slots = computeSlots({
      date: "2026-10-04", // Sunday
      durationMin: 30,
      intervalMin: 15,
      hours: [{ weekday: 1, start_min: 600, end_min: 1140 }],
      busy: [],
      earliest: "2026-10-01 00:00",
    });
    assert.deepEqual(slots, []);
  });
});

function setup() {
  setDb(openDb(":memory:"));
  const { shopId, userId: ownerId } = createShopWithOwner({
    shopName: "Test Shop",
    ownerName: "Owner",
    email: "owner@test.dev",
    password: "password1",
    timezone: "America/Mexico_City",
    currency: "USD",
    hasChair: true,
  });
  const barberId = createUser({ shopId, name: "Barb", email: "barb@test.dev", password: "password1", role: "barber", hasChair: true });
  const serviceId = Number(
    getDb().prepare("INSERT INTO services (barber_id, name, duration_min, price_cents) VALUES (?, 'Cut', 30, 2000)").run(barberId)
      .lastInsertRowid,
  );
  return { shop: getShop(shopId), ownerId, barberId, serviceId };
}

describe("booking flow", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const request = (time: string, extra: Partial<Parameters<typeof createBooking>[0]> = {}) =>
    createBooking(
      {
        shopSlug: ctx.shop.slug,
        barberId: ctx.barberId,
        serviceId: ctx.serviceId,
        date: MONDAY,
        time,
        clientName: "Diego",
        clientPhone: "55 1234 5678",
        ...extra,
      },
      NOW,
    );

  test("slots respect default hours and minimum notice", () => {
    const slots = getSlots(ctx.shop, ctx.barberId, 30, MONDAY, NOW);
    // Shop opens 10:00; now is 08:00 with 60 min notice, so 10:00 is the first slot.
    assert.equal(slots[0], "10:00");
    assert.equal(slots.at(-1), "18:30");
    assert.deepEqual(getSlots(ctx.shop, ctx.barberId, 30, "2026-10-04", NOW), [], "past days have no slots");
    assert.deepEqual(getSlots(ctx.shop, ctx.barberId, 30, addDays(MONDAY, 31), NOW), [], "beyond booking window");
  });

  test("auto-confirms by default and blocks the slot", () => {
    const r = request("10:00");
    assert.ok(r.ok);
    assert.equal(r.status, "confirmed");
    assert.ok(!getSlots(ctx.shop, ctx.barberId, 30, MONDAY, NOW).includes("10:00"));
    assert.ok(!getSlots(ctx.shop, ctx.barberId, 30, MONDAY, NOW).includes("09:45"));
    const again = request("10:00", { clientName: "Someone else" });
    assert.equal(again.ok, false);
  });

  test("approval mode holds the slot as pending until the barber decides", () => {
    getDb().prepare("UPDATE users SET requires_approval = 1 WHERE id = ?").run(ctx.barberId);
    const r = request("11:00");
    assert.ok(r.ok && r.status === "pending");
    assert.equal(request("11:00").ok, false, "pending requests hold the slot");
    const appt = getAppointmentByToken(r.token)!;
    assert.ok(applyBarberAction(ctx.barberId, appt.id, { type: "reject" }, ctx.shop.timezone));
    assert.ok(request("11:00").ok, "declined slot opens back up");
  });

  test("other barbers can't act on someone else's appointment", () => {
    const r = request("12:00");
    assert.ok(r.ok);
    const appt = getAppointmentByToken(r.token)!;
    assert.equal(applyBarberAction(ctx.ownerId, appt.id, { type: "cancel" }, ctx.shop.timezone), false);
  });

  test("client cancel frees the slot; only once", () => {
    const r = request("13:00");
    assert.ok(r.ok);
    assert.ok(cancelByClient(r.token));
    assert.equal(cancelByClient(r.token), false);
    assert.ok(getSlots(ctx.shop, ctx.barberId, 30, MONDAY, NOW).includes("13:00"));
  });

  test("validates client details and hides barbers without a chair", () => {
    assert.equal(request("14:00", { clientName: "" }).ok, false);
    assert.equal(request("14:00", { clientPhone: "12" }).ok, false);
    getDb().prepare("UPDATE users SET has_chair = 0 WHERE id = ?").run(ctx.barberId);
    assert.equal(request("14:00").ok, false);
  });

  test("time off removes slots", () => {
    getDb()
      .prepare("INSERT INTO time_off (barber_id, start_at, end_at) VALUES (?, ?, ?)")
      .run(ctx.barberId, `${MONDAY} 13:00`, `${MONDAY} 15:00`);
    const slots = getSlots(ctx.shop, ctx.barberId, 30, MONDAY, NOW);
    assert.ok(slots.includes("12:30") && !slots.includes("12:45") && !slots.includes("14:30") && slots.includes("15:00"));
  });

  test("completed cuts feed finances and shop analytics", () => {
    const r = request("10:00");
    assert.ok(r.ok);
    const appt = getAppointmentByToken(r.token)!;
    getDb().prepare("UPDATE appointments SET started_at = ? WHERE id = ?").run(`${MONDAY} 10:00`, appt.id);
    assert.ok(
      applyBarberAction(ctx.barberId, appt.id, { type: "complete", chargedCents: 2500, tipCents: 300, paymentMethod: "cash" }, ctx.shop.timezone),
    );
    getDb().prepare("UPDATE appointments SET finished_at = ? WHERE id = ?").run(`${MONDAY} 10:40`, appt.id);
    assert.ok(createWalkIn(ctx.shop, ctx.barberId, { serviceId: ctx.serviceId, clientName: "", clientPhone: "", date: MONDAY, time: "16:00" }).ok);
    assert.equal(
      createWalkIn(ctx.shop, ctx.barberId, { serviceId: ctx.serviceId, clientName: "", clientPhone: "", date: MONDAY, time: "16:15" }).ok,
      false,
      "walk-ins can't double-book",
    );
    getDb().prepare("INSERT INTO expenses (barber_id, date, amount_cents, category) VALUES (?, ?, 1000, 'Products')").run(ctx.barberId, MONDAY);

    const f = barberFinances(ctx.barberId, MONDAY, MONDAY);
    assert.equal(f.revenueCents, 2500);
    assert.equal(f.tipsCents, 300);
    assert.equal(f.netCents, 1800);
    assert.equal(f.completed, 1);

    const a = shopAnalytics(ctx.shop.id, MONDAY, MONDAY);
    assert.equal(a.completed, 1);
    assert.equal(a.avgCutMin, 40);
    assert.equal(a.byHour[10], 1);
    assert.equal(a.byHour[16], 1);
    assert.equal(a.onlineShare, 0.5);
    const barb = a.barbers.find((b) => b.id === ctx.barberId)!;
    assert.equal(barb.revenueCents, null, "earnings stay private by default");
  });
});

test("nowInTz formats shop-local time", () => {
  assert.equal(nowInTz("America/Mexico_City", NOW), "2026-10-05 08:00");
  assert.equal(nowInTz("Europe/Madrid", NOW), "2026-10-05 16:00");
});
