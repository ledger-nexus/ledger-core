"use server";

// Server Action to mark notifications as seen. Anti-spoofing inside
// markRead: only the recipient can mark their own notifications.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { markRead } from "@/lib/notifications";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";

export interface MarkNotificationsReadState {
  ok: boolean;
  markedCount?: number;
  message?: string;
}

export async function markNotificationsReadAction(
  input?: { notificationIds?: string[] }
): Promise<MarkNotificationsReadState> {
  try {
    const user = await requireCurrentUser();
    const { markedCount } = await markRead(
      prisma,
      user.id,
      input?.notificationIds ?? null
    );
    revalidatePath("/", "layout"); // refresh the bell badge
    return { ok: true, markedCount };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
