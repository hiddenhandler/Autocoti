"use server";

import { redirect } from "next/navigation";
import { createShopWithOwner, emailTaken, verifyLogin } from "@/lib/accounts";
import { endSession, startSession } from "@/lib/auth";
import type { ActionResult } from "@/components/action-form";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function login(fd: FormData): Promise<ActionResult> {
  const user = verifyLogin(str(fd, "email"), String(fd.get("password") ?? ""));
  if (!user) return { error: "Wrong email or password." };
  await startSession(user.id);
  redirect("/dashboard");
}

export async function signup(fd: FormData): Promise<ActionResult> {
  const shopName = str(fd, "shopName");
  const ownerName = str(fd, "ownerName");
  const email = str(fd, "email");
  const password = String(fd.get("password") ?? "");
  const timezone = str(fd, "timezone") || "UTC";
  const currency = str(fd, "currency") || "USD";
  if (shopName.length < 2 || ownerName.length < 2) return { error: "Shop name and your name are required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (emailTaken(email)) return { error: "That email already has an account. Log in instead." };
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return { error: "Unknown time zone." };
  }
  const { userId } = createShopWithOwner({
    shopName,
    ownerName,
    email,
    password,
    timezone,
    currency,
    hasChair: fd.get("hasChair") === "on",
  });
  await startSession(userId);
  redirect("/dashboard/services?welcome=1");
}

export async function logout() {
  await endSession();
  redirect("/login");
}
