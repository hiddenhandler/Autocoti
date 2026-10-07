import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, USER_COLUMNS, type Shop, type User } from "./db";
import { getShop } from "./booking";

const COOKIE = "autocoti_session";
const SESSION_DAYS = 30;

export async function startSession(userId: number) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  getDb().prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires.toISOString());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<User | undefined> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return undefined;
  return getDb()
    .prepare(
      `SELECT ${USER_COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")} FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(token, new Date().toISOString()) as User | undefined;
}

/** For dashboard pages and server actions: only the shop's owner and barbers get past this. */
export async function requireUser(): Promise<{ user: User; shop: Shop }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return { user, shop: getShop(user.shop_id) };
}

export async function requireOwner(): Promise<{ user: User; shop: Shop }> {
  const ctx = await requireUser();
  if (ctx.user.role !== "owner") redirect("/dashboard");
  return ctx;
}
