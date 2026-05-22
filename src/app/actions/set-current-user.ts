"use server";

// Server Action that writes the current-user cookie. Backs the
// UserSwitcher dropdown in the nav.
//
// Verifies the picked user exists and is active before signing the
// cookie — prevents a tampered POST from setting a cookie that
// references a deactivated or nonexistent user (which would then be
// silently rejected by getCurrentUser anyway).

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { _internal } from "@/lib/auth/current-user";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface SetCurrentUserState {
  ok: boolean;
  message?: string;
}

export async function setCurrentUserAction(
  userId: string
): Promise<SetCurrentUserState> {
  if (!userId || userId === "__none__") {
    // Clear the cookie.
    cookies().delete(_internal.cookieName);
    revalidatePath("/", "layout");
    return { ok: true };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true },
  });
  if (!user) return { ok: false, message: "User not found" };
  if (!user.isActive) return { ok: false, message: "User is inactive" };

  cookies().set(_internal.cookieName, _internal.encode(user.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    // Secure flag set by Next automatically in production.
  });
  revalidatePath("/", "layout");
  return { ok: true };
}
