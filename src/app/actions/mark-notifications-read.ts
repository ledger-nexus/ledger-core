"use server";

// Server Action to mark notifications as seen. Anti-spoofing inside
// markRead: only the recipient can mark their own notifications.
//
// RLS Phase 2b reference example. See
// docs/architecture/rls-phase-2b-migration-guide.md for the pattern.
// Migrated from raw-prisma to withTenantContext on 2026-06-05 as the
// canonical Group A reference (smallest production action with real
// DB work + helper-passed prisma).
//
// Functional behavior unchanged today (RLS isn't FORCED yet). Once
// Phase 3 lands, every notification query inside this action is
// automatically scoped to the current tenant.

import { revalidatePath } from "next/cache";
import { withTenantContext } from "@/lib/db/tenant-context";
import { markRead } from "@/lib/notifications";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import {
  requireCurrentTenant,
  NoTenantSelectedError,
} from "@/lib/auth/tenant";

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
    // 2026-06-05 RLS migration: requireCurrentTenant added so the
    // withTenantContext wrapper has a tenantId. Today (Phase 2b)
    // this just sets the GUC; once Phase 3 FORCES RLS, this is the
    // load-bearing tenant assertion.
    const tenant = await requireCurrentTenant();

    const { markedCount } = await withTenantContext(tenant.id, async (tx) => {
      return markRead(tx, user.id, input?.notificationIds ?? null);
    });

    revalidatePath("/", "layout"); // refresh the bell badge
    return { ok: true, markedCount };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, message: e.message };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
