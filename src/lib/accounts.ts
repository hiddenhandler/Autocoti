import bcrypt from "bcryptjs";
import { getDb, USER_COLUMNS, type User } from "./db";

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function uniqueSlug(base: string): string {
  const db = getDb();
  const root = slugify(base) || "shop";
  let slug = root;
  for (let i = 2; db.prepare("SELECT 1 FROM shops WHERE slug = ?").get(slug); i++) slug = `${root}-${i}`;
  return slug;
}

/** Monday–Saturday, 10:00–19:00: a sensible default the barber edits later. */
export const DEFAULT_HOURS = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_min: 600, end_min: 1140 }));

export function createUser(input: {
  shopId: number;
  name: string;
  email: string;
  password: string;
  role: "owner" | "barber";
  hasChair: boolean;
}): number {
  const db = getDb();
  const id = Number(
    db
      .prepare(
        "INSERT INTO users (shop_id, name, email, password_hash, role, has_chair) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(input.shopId, input.name.trim(), input.email.trim(), bcrypt.hashSync(input.password, 10), input.role, input.hasChair ? 1 : 0)
      .lastInsertRowid,
  );
  const insertHours = db.prepare("INSERT INTO working_hours (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)");
  for (const h of DEFAULT_HOURS) insertHours.run(id, h.weekday, h.start_min, h.end_min);
  return id;
}

export function createShopWithOwner(input: {
  shopName: string;
  timezone: string;
  currency: string;
  ownerName: string;
  email: string;
  password: string;
  hasChair: boolean;
}): { shopId: number; userId: number } {
  const db = getDb();
  return db.transaction(() => {
    const shopId = Number(
      db
        .prepare("INSERT INTO shops (name, slug, timezone, currency) VALUES (?, ?, ?, ?)")
        .run(input.shopName.trim(), uniqueSlug(input.shopName), input.timezone, input.currency).lastInsertRowid,
    );
    const userId = createUser({
      shopId,
      name: input.ownerName,
      email: input.email,
      password: input.password,
      role: "owner",
      hasChair: input.hasChair,
    });
    return { shopId, userId };
  })();
}

export function emailTaken(email: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM users WHERE email = ?").get(email.trim());
}

export function verifyLogin(email: string, password: string): User | undefined {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ? AND active = 1`)
    .get(email.trim()) as (User & { password_hash: string }) | undefined;
  if (!row || !bcrypt.compareSync(password, row.password_hash)) return undefined;
  const { password_hash: _ignored, ...user } = row;
  return user;
}

export function setPassword(userId: number, password: string) {
  getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), userId);
}
