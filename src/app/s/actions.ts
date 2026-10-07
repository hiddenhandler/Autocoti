"use server";

import { redirect } from "next/navigation";
import { cancelByClient, createBooking } from "@/lib/booking";
import type { ActionResult } from "@/components/action-form";

export async function book(fd: FormData): Promise<ActionResult> {
  const result = createBooking({
    shopSlug: String(fd.get("shopSlug") ?? ""),
    barberId: Number(fd.get("barberId")),
    serviceId: Number(fd.get("serviceId")),
    date: String(fd.get("date") ?? ""),
    time: String(fd.get("time") ?? ""),
    clientName: String(fd.get("clientName") ?? ""),
    clientPhone: String(fd.get("clientPhone") ?? ""),
    clientNote: String(fd.get("clientNote") ?? ""),
  });
  if (!result.ok) return { error: result.error };
  redirect(`/b/${result.token}?new=1`);
}

export async function cancelBooking(token: string) {
  cancelByClient(token);
  redirect(`/b/${token}`);
}
