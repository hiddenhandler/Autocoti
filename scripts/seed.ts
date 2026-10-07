// Creates a demo shop at /s/demo with three barbers and ~60 days of history.
// Usage: npm run seed   (log in as owner@demo.test / demo1234)
import crypto from "node:crypto";
import { createShopWithOwner, createUser } from "../src/lib/accounts";
import { getDb } from "../src/lib/db";
import { addDays, addMinutes, minutesToHHMM, todayInTz, weekdayOf } from "../src/lib/time";

const db = getDb();
const TZ = process.env.SEED_TZ ?? "America/Mexico_City";

const existing = db.prepare("SELECT id FROM shops WHERE slug = 'demo'").get() as { id: number } | undefined;
if (existing) {
  db.prepare("DELETE FROM shops WHERE id = ?").run(existing.id);
  console.log("Removed previous demo shop.");
}

// Deterministic pseudo-random so the demo looks the same every time.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const { shopId, userId: ownerId } = createShopWithOwner({
  shopName: "Demo",
  ownerName: "Carlos",
  email: "owner@demo.test",
  password: "demo1234",
  timezone: TZ,
  currency: "USD",
  hasChair: true,
});
db.prepare("UPDATE shops SET name = 'Navaja Barber Co.', address = 'Av. Reforma 120, CDMX' WHERE id = ?").run(shopId);
db.prepare("UPDATE users SET share_earnings = 1, bio = 'Owner. Classic cuts & hot towel shaves.' WHERE id = ?").run(ownerId);

const luis = createUser({ shopId, name: "Luis", email: "luis@demo.test", password: "demo1234", role: "barber", hasChair: true });
const ana = createUser({ shopId, name: "Ana", email: "ana@demo.test", password: "demo1234", role: "barber", hasChair: true });
db.prepare("UPDATE users SET requires_approval = 1, bio = 'Fades and designs. I confirm every booking myself.' WHERE id = ?").run(luis);
db.prepare("UPDATE users SET share_earnings = 1, bio = 'Beards, long hair, kids.' WHERE id = ?").run(ana);

const MENU: [string, number, number][] = [
  ["Haircut", 30, 2000],
  ["Skin fade", 45, 2500],
  ["Beard trim", 20, 1200],
  ["Cut + beard", 60, 3000],
  ["Kids cut", 25, 1500],
];
const insertService = db.prepare("INSERT INTO services (barber_id, name, duration_min, price_cents) VALUES (?, ?, ?, ?)");
const servicesBy = new Map<number, { id: number; name: string; dur: number; price: number }[]>();
for (const b of [ownerId, luis, ana]) {
  servicesBy.set(
    b,
    MENU.map(([name, dur, price]) => {
      const p = b === luis ? price + 300 : price;
      return { id: Number(insertService.run(b, name, dur, p).lastInsertRowid), name, dur, price: p };
    }),
  );
}
// Ana works a split shift Tue–Sat.
db.prepare("DELETE FROM working_hours WHERE barber_id = ?").run(ana);
for (const wd of [2, 3, 4, 5, 6]) {
  db.prepare("INSERT INTO working_hours (barber_id, weekday, start_min, end_min) VALUES (?, ?, 540, 840), (?, ?, 900, 1200)").run(ana, wd, ana, wd);
}

const NAMES = ["Diego", "Marco", "Javier", "Pablo", "Andrés", "Mateo", "Iván", "Rafa", "Tomás", "Emilio", "Bruno", "Santi", "Óscar", "Leo"];
const insertAppt = db.prepare(`INSERT INTO appointments
  (shop_id, barber_id, service_id, service_name, client_name, client_phone, start_at, end_at, status, source,
   quoted_cents, charged_cents, tip_cents, payment_method, started_at, finished_at, token, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

const today = todayInTz(TZ);
const hourWeight = (h: number) => (h >= 17 ? 3 : h >= 12 && h < 14 ? 2.2 : h >= 10 ? 1.4 : 0.6);
const dayWeight = [0.2, 0.7, 0.8, 0.9, 1.1, 1.6, 2];
let count = 0;

for (let offset = -60; offset <= 10; offset++) {
  const date = addDays(today, offset);
  const wd = weekdayOf(date);
  for (const barber of [ownerId, luis, ana]) {
    const hours = db.prepare("SELECT start_min, end_min FROM working_hours WHERE barber_id = ? AND weekday = ?").all(barber, wd) as {
      start_min: number;
      end_min: number;
    }[];
    for (const h of hours) {
      let t = h.start_min;
      while (t < h.end_min) {
        const svc = pick(servicesBy.get(barber)!);
        if (t + svc.dur > h.end_min) break;
        const fill = (offset > 0 ? 0.12 : 0.42) * hourWeight(Math.floor(t / 60)) * dayWeight[wd];
        if (rand() < fill) {
          const start = `${date} ${minutesToHHMM(t)}`;
          const end = addMinutes(start, svc.dur);
          const past = offset < 0;
          const r = rand();
          let status = past ? (r < 0.06 ? "no_show" : r < 0.1 ? "cancelled" : "completed") : barber === luis && r < 0.25 ? "pending" : "confirmed";
          if (offset === 0) status = t < 12 * 60 ? "completed" : "confirmed";
          const walkIn = rand() < 0.25;
          const actual = Math.max(10, Math.round(svc.dur + (rand() - 0.45) * 14));
          const done = status === "completed";
          insertAppt.run(
            shopId, barber, svc.id, svc.name, pick(NAMES), `55 ${Math.floor(1000 + rand() * 9000)} ${Math.floor(1000 + rand() * 9000)}`,
            start, end, status, walkIn ? "walk_in" : "online", svc.price,
            done ? svc.price + (rand() < 0.15 ? 500 : 0) : null,
            done && rand() < 0.5 ? pick([200, 300, 500]) : 0,
            done ? pick(["cash", "cash", "card", "transfer"]) : null,
            done ? start : null,
            done ? addMinutes(start, actual) : null,
            crypto.randomBytes(16).toString("base64url"),
          );
          count++;
          t += svc.dur;
        } else {
          t += 15;
        }
      }
    }
  }
}

const insertExpense = db.prepare("INSERT INTO expenses (barber_id, date, amount_cents, category, note) VALUES (?, ?, ?, ?, ?)");
for (const b of [luis, ana]) {
  for (const m of [-60, -30, 0]) insertExpense.run(b, addDays(today, m), 40000, "Chair rent", "Monthly chair");
  insertExpense.run(b, addDays(today, -12), 3500, "Products", "Pomade + clippers oil");
}

console.log(`Demo shop ready at /s/demo with ${count} appointments.`);
console.log("Log in: owner@demo.test, luis@demo.test or ana@demo.test — password demo1234");
