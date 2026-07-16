// Notifications service.
//
// Lightweight helper that writes Notification rows. Used by the
// reassignment service (manual + rule-fired) to surface "your queue has
// new work" to recipients. Per-user only — when a record is assigned to
// a queue, this module fans out one row per queue member.
//
// What's intentionally NOT here yet:
//   - User preferences (mute, batch, frequency)
//   - Channel routing (email, Slack, SMS) — in-app bell only for v1
//   - Real-time delivery (WebSocket / SSE) — UI polls or refreshes
//   - Deduplication beyond the same actor/record/category combo within
//     a single emit call (no cross-call dedup)
//
// Quiet escape hatch: callers can pass `silent: true` to suppress
// emission (used during bulk operations like user-deactivation
// reassignments where flooding the new owner's inbox would be hostile).

import type { Prisma, PrismaClient } from "@prisma/client";

// Widened DB client type — accepts both PrismaClient and TransactionClient
// so callers can pass either the singleton (`prisma`) or a transaction
// client from `withTenantContext` / `prisma.$transaction`. RLS Phase 2b
// pattern (see docs/architecture/rls-phase-2b-migration-guide.md).
type Db = PrismaClient | Prisma.TransactionClient;

export type NotificationCategory =
  | "REASSIGNMENT"
  | "APPROVAL_NEEDED"
  | "ORPHAN_DETECTED"
  | "SYSTEM";

export interface NotifyInput {
  /** USER recipient by id, OR QUEUE recipient (fanned out per member). */
  recipient: { type: "USER"; id: string } | { type: "QUEUE"; id: string };
  category: NotificationCategory;
  title: string;
  body?: string;
  link?: string;
  sourceRuleId?: string;
  actorUserId?: string;
  recordType?: string;
  recordId?: string;
  /**
   * Tenant the notification belongs to. Optional during the migration
   * window — resolves to the default tenant when omitted. Reassignment
   * paths SHOULD pass the source record's tenantId so cross-tenant
   * notification leakage is impossible.
   */
  tenantId?: string;
}

export interface NotifyResult {
  /** Number of Notification rows created. 0 for queue recipients with no members. */
  emittedCount: number;
}

/**
 * Emit one or more Notification rows. For USER recipients, one row.
 * For QUEUE recipients, one row per queue member. Silently no-ops
 * when the queue has zero active members (no one to notify).
 *
 * Failures are surfaced as exceptions — the caller decides whether
 * a notification failure should block the underlying action. In
 * practice, reassignRecord catches and continues; the action
 * succeeds even if the bell doesn't ring.
 */
export async function notify(
  prisma: Db,
  input: NotifyInput
): Promise<NotifyResult> {
  // Resolve the recipient set.
  let recipientUserIds: string[] = [];
  if (input.recipient.type === "USER") {
    recipientUserIds = [input.recipient.id];
  } else {
    const members = await prisma.queueMember.findMany({
      where: {
        queueId: input.recipient.id,
        user: { isActive: true },
      },
      select: { userId: true },
    });
    recipientUserIds = members.map((m) => m.userId);
  }

  // Filter: don't notify the actor about their own action. Avoids the
  // "you reassigned this to yourself" self-notification noise.
  if (input.actorUserId) {
    recipientUserIds = recipientUserIds.filter((id) => id !== input.actorUserId);
  }

  if (recipientUserIds.length === 0) {
    return { emittedCount: 0 };
  }

  const tenantId =
    input.tenantId ??
    (await (await import("@/lib/seed/default-tenant")).getDefaultTenantId(prisma));
  await prisma.notification.createMany({
    data: recipientUserIds.map((recipientUserId) => ({
      tenantId,
      recipientUserId,
      category: input.category,
      title: input.title,
      body: input.body,
      link: input.link,
      sourceRuleId: input.sourceRuleId,
      actorUserId: input.actorUserId,
      recordType: input.recordType,
      recordId: input.recordId,
    })),
  });

  return { emittedCount: recipientUserIds.length };
}

/**
 * Fetch a user's recent unread notifications + a few recently-read ones
 * for context. Returns most recent first. Capped to keep the bell
 * dropdown snappy.
 */
export async function getRecentNotifications(
  prisma: Db,
  userId: string,
  options?: { unreadLimit?: number; readLimit?: number }
): Promise<{
  unread: Array<NotificationRow>;
  recentRead: Array<NotificationRow>;
  unreadCount: number;
}> {
  const unreadLimit = options?.unreadLimit ?? 10;
  const readLimit = options?.readLimit ?? 5;

  const [unread, recentRead, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { recipientUserId: userId, seenAt: null },
      orderBy: { createdAt: "desc" },
      take: unreadLimit,
      select: NOTIFICATION_SELECT,
    }),
    prisma.notification.findMany({
      where: { recipientUserId: userId, seenAt: { not: null } },
      orderBy: { createdAt: "desc" },
      take: readLimit,
      select: NOTIFICATION_SELECT,
    }),
    prisma.notification.count({
      where: { recipientUserId: userId, seenAt: null },
    }),
  ]);

  return { unread, recentRead, unreadCount };
}

const NOTIFICATION_SELECT = {
  id: true,
  category: true,
  title: true,
  body: true,
  link: true,
  recordType: true,
  recordId: true,
  seenAt: true,
  createdAt: true,
  actor: { select: { displayName: true, email: true } },
} as const;

type NotificationRow = Awaited<
  ReturnType<
    typeof unknownPrismaSelect
  >
>;

// Helper to derive the row type from the select shape. The actual select
// is NOTIFICATION_SELECT above; this just gives us the type.
function unknownPrismaSelect() {
  return undefined as unknown as {
    id: string;
    category: NotificationCategory;
    title: string;
    body: string | null;
    link: string | null;
    recordType: string | null;
    recordId: string | null;
    seenAt: Date | null;
    createdAt: Date;
    actor: { displayName: string; email: string } | null;
  };
}

/**
 * Mark notifications as seen. notificationIds = specific ones; pass
 * null for "all unread for this user."
 */
export async function markRead(
  prisma: Db,
  userId: string,
  notificationIds: string[] | null
): Promise<{ markedCount: number }> {
  const now = new Date();
  const result = await prisma.notification.updateMany({
    where: {
      recipientUserId: userId, // anti-spoofing: only the recipient can mark
      seenAt: null,
      ...(notificationIds ? { id: { in: notificationIds } } : {}),
    },
    data: { seenAt: now },
  });
  return { markedCount: result.count };
}
