// Orphan detection — find records whose owner is no longer valid.
//
// "Valid" means:
//   - For USER owners: the user exists AND is active. (Module-access checking
//     is NOT done here — that requires a roles/permissions layer that hasn't
//     landed yet. When it does, this function should be extended to also
//     check `user has access to recordType's module`.)
//   - For QUEUE owners: the queue exists AND is active AND not soft-deleted.
//
// This is a read-only diagnostic — it does NOT auto-reassign. The caller
// (admin UI dashboard, role-change preflight) inspects the result and
// decides what to do.
//
// Scope: JournalEntry only in this initial cut. Each new ownership-bearing
// record type adds a branch here. Eventually this is a periodic scan
// materialized into a table for the admin dashboard.

import { PrismaClient } from "@prisma/client";

export interface OrphanedRecord {
  recordType: "JournalEntry" | "ArOpenItem" | "ApOpenItem";
  recordId: string;
  ownerId: string | null;
  ownerType: "USER" | "QUEUE";
  cause:
    | "OWNER_USER_NOT_FOUND"
    | "OWNER_USER_INACTIVE"
    | "OWNER_QUEUE_NOT_FOUND"
    | "OWNER_QUEUE_INACTIVE"
    | "OWNER_QUEUE_DELETED"
    | "OWNER_ID_NULL";
  // Useful display context for the dashboard.
  entityCode?: string;
  bookCode?: string;
  ageDays: number;
}

export interface OrphanScanInput {
  /** Limit by record type. Default: all ownership-bearing types. */
  recordType?: "JournalEntry" | "ArOpenItem" | "ApOpenItem";
  /** Limit by entity (multi-tenant orgs scope per entity). */
  entityId?: string;
  /** Cap on returned rows. Default 500. */
  limit?: number;
}

export async function findOrphans(
  prisma: PrismaClient,
  input: OrphanScanInput = {}
): Promise<OrphanedRecord[]> {
  const limit = input.limit ?? 500;
  const results: OrphanedRecord[] = [];

  // ─── JournalEntry orphans ─────────────────────────────────────────────────
  if (!input.recordType || input.recordType === "JournalEntry") {
    const candidates = await prisma.journalEntry.findMany({
      where: {
        ...(input.entityId ? { entityId: input.entityId } : {}),
      },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        createdAt: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      take: limit * 4, // overscan; we'll filter
    });

    if (candidates.length === 0) return results;

    // Bulk-load referenced owners.
    const userOwnerIds = new Set<string>();
    const queueOwnerIds = new Set<string>();
    for (const c of candidates) {
      if (!c.ownerId) continue;
      if (c.ownerType === "USER") userOwnerIds.add(c.ownerId);
      else if (c.ownerType === "QUEUE") queueOwnerIds.add(c.ownerId);
    }

    const [users, queues] = await Promise.all([
      userOwnerIds.size > 0
        ? prisma.user.findMany({
            where: { id: { in: [...userOwnerIds] } },
            select: { id: true, isActive: true },
          })
        : Promise.resolve([]),
      queueOwnerIds.size > 0
        ? prisma.queue.findMany({
            where: { id: { in: [...queueOwnerIds] } },
            select: { id: true, isActive: true, deletedAt: true },
          })
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const queueMap = new Map(queues.map((q) => [q.id, q]));

    const now = Date.now();
    for (const c of candidates) {
      if (results.length >= limit) break;

      let cause: OrphanedRecord["cause"] | null = null;

      if (!c.ownerId) {
        cause = "OWNER_ID_NULL";
      } else if (c.ownerType === "USER") {
        const u = userMap.get(c.ownerId);
        if (!u) cause = "OWNER_USER_NOT_FOUND";
        else if (!u.isActive) cause = "OWNER_USER_INACTIVE";
      } else if (c.ownerType === "QUEUE") {
        const q = queueMap.get(c.ownerId);
        if (!q) cause = "OWNER_QUEUE_NOT_FOUND";
        else if (q.deletedAt) cause = "OWNER_QUEUE_DELETED";
        else if (!q.isActive) cause = "OWNER_QUEUE_INACTIVE";
      }

      if (cause) {
        results.push({
          recordType: "JournalEntry",
          recordId: c.id,
          ownerId: c.ownerId,
          ownerType: c.ownerType,
          cause,
          entityCode: c.entity.code,
          bookCode: c.book.code,
          ageDays: Math.floor((now - c.createdAt.getTime()) / 86400000),
        });
      }
    }
  }

  // ─── ArOpenItem orphans ───────────────────────────────────────────────────
  if (!input.recordType || input.recordType === "ArOpenItem") {
    if (results.length >= limit) return results;

    const candidates = await prisma.arOpenItem.findMany({
      where: {
        ...(input.entityId ? { entityId: input.entityId } : {}),
        // Don't surface terminal-state items as orphans — once an item is
        // APPLIED / WRITTEN_OFF / VOID, ownership is intentionally frozen
        // even if the owner is no longer active.
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        createdAt: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      take: (limit - results.length) * 4,
    });

    if (candidates.length === 0) return results;

    const userOwnerIds = new Set<string>();
    const queueOwnerIds = new Set<string>();
    for (const c of candidates) {
      if (!c.ownerId) continue;
      if (c.ownerType === "USER") userOwnerIds.add(c.ownerId);
      else if (c.ownerType === "QUEUE") queueOwnerIds.add(c.ownerId);
    }

    const [users, queues] = await Promise.all([
      userOwnerIds.size > 0
        ? prisma.user.findMany({
            where: { id: { in: [...userOwnerIds] } },
            select: { id: true, isActive: true },
          })
        : Promise.resolve([]),
      queueOwnerIds.size > 0
        ? prisma.queue.findMany({
            where: { id: { in: [...queueOwnerIds] } },
            select: { id: true, isActive: true, deletedAt: true },
          })
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const queueMap = new Map(queues.map((q) => [q.id, q]));

    const now = Date.now();
    for (const c of candidates) {
      if (results.length >= limit) break;

      let cause: OrphanedRecord["cause"] | null = null;

      if (!c.ownerId) {
        cause = "OWNER_ID_NULL";
      } else if (c.ownerType === "USER") {
        const u = userMap.get(c.ownerId);
        if (!u) cause = "OWNER_USER_NOT_FOUND";
        else if (!u.isActive) cause = "OWNER_USER_INACTIVE";
      } else if (c.ownerType === "QUEUE") {
        const q = queueMap.get(c.ownerId);
        if (!q) cause = "OWNER_QUEUE_NOT_FOUND";
        else if (q.deletedAt) cause = "OWNER_QUEUE_DELETED";
        else if (!q.isActive) cause = "OWNER_QUEUE_INACTIVE";
      }

      if (cause) {
        results.push({
          recordType: "ArOpenItem",
          recordId: c.id,
          ownerId: c.ownerId,
          ownerType: c.ownerType,
          cause,
          entityCode: c.entity.code,
          bookCode: c.book.code,
          ageDays: Math.floor((now - c.createdAt.getTime()) / 86400000),
        });
      }
    }
  }

  // ─── ApOpenItem orphans ───────────────────────────────────────────────────
  if (!input.recordType || input.recordType === "ApOpenItem") {
    if (results.length >= limit) return results;

    const candidates = await prisma.apOpenItem.findMany({
      where: {
        ...(input.entityId ? { entityId: input.entityId } : {}),
        // Terminal-state items are intentionally frozen — don't surface.
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        createdAt: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      take: (limit - results.length) * 4,
    });

    if (candidates.length === 0) return results;

    const userOwnerIds = new Set<string>();
    const queueOwnerIds = new Set<string>();
    for (const c of candidates) {
      if (!c.ownerId) continue;
      if (c.ownerType === "USER") userOwnerIds.add(c.ownerId);
      else if (c.ownerType === "QUEUE") queueOwnerIds.add(c.ownerId);
    }

    const [users, queues] = await Promise.all([
      userOwnerIds.size > 0
        ? prisma.user.findMany({
            where: { id: { in: [...userOwnerIds] } },
            select: { id: true, isActive: true },
          })
        : Promise.resolve([]),
      queueOwnerIds.size > 0
        ? prisma.queue.findMany({
            where: { id: { in: [...queueOwnerIds] } },
            select: { id: true, isActive: true, deletedAt: true },
          })
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const queueMap = new Map(queues.map((q) => [q.id, q]));

    const now = Date.now();
    for (const c of candidates) {
      if (results.length >= limit) break;

      let cause: OrphanedRecord["cause"] | null = null;

      if (!c.ownerId) {
        cause = "OWNER_ID_NULL";
      } else if (c.ownerType === "USER") {
        const u = userMap.get(c.ownerId);
        if (!u) cause = "OWNER_USER_NOT_FOUND";
        else if (!u.isActive) cause = "OWNER_USER_INACTIVE";
      } else if (c.ownerType === "QUEUE") {
        const q = queueMap.get(c.ownerId);
        if (!q) cause = "OWNER_QUEUE_NOT_FOUND";
        else if (q.deletedAt) cause = "OWNER_QUEUE_DELETED";
        else if (!q.isActive) cause = "OWNER_QUEUE_INACTIVE";
      }

      if (cause) {
        results.push({
          recordType: "ApOpenItem",
          recordId: c.id,
          ownerId: c.ownerId,
          ownerType: c.ownerType,
          cause,
          entityCode: c.entity.code,
          bookCode: c.book.code,
          ageDays: Math.floor((now - c.createdAt.getTime()) / 86400000),
        });
      }
    }
  }

  return results;
}

// Bulk orphan resolution — call after a role change or user deactivation to
// preview what will become orphaned. Read-only; doesn't mutate.
export async function previewOrphansForUserChange(
  prisma: PrismaClient,
  userId: string
): Promise<OrphanedRecord[]> {
  // Pre-deactivation: anything currently owned by the user is about to
  // become an orphan if we don't reassign. This is what the role-change
  // preflight UI shows. We treat ALL of their owned records as imminent
  // orphans regardless of whether the cause is active right now.
  const [jes, ars, aps] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { ownerId: userId, ownerType: "USER" },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        createdAt: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      take: 500,
    }),
    prisma.arOpenItem.findMany({
      where: {
        ownerId: userId,
        ownerType: "USER",
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        createdAt: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      take: 500,
    }),
    prisma.apOpenItem.findMany({
      where: {
        ownerId: userId,
        ownerType: "USER",
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      select: {
        id: true,
        ownerId: true,
        ownerType: true,
        createdAt: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      take: 500,
    }),
  ]);

  const now = Date.now();
  const out: OrphanedRecord[] = [];
  for (const c of jes) {
    out.push({
      recordType: "JournalEntry",
      recordId: c.id,
      ownerId: c.ownerId,
      ownerType: c.ownerType,
      cause: "OWNER_USER_INACTIVE",
      entityCode: c.entity.code,
      bookCode: c.book.code,
      ageDays: Math.floor((now - c.createdAt.getTime()) / 86400000),
    });
  }
  for (const c of ars) {
    out.push({
      recordType: "ArOpenItem",
      recordId: c.id,
      ownerId: c.ownerId,
      ownerType: c.ownerType,
      cause: "OWNER_USER_INACTIVE",
      entityCode: c.entity.code,
      bookCode: c.book.code,
      ageDays: Math.floor((now - c.createdAt.getTime()) / 86400000),
    });
  }
  for (const c of aps) {
    out.push({
      recordType: "ApOpenItem",
      recordId: c.id,
      ownerId: c.ownerId,
      ownerType: c.ownerType,
      cause: "OWNER_USER_INACTIVE",
      entityCode: c.entity.code,
      bookCode: c.book.code,
      ageDays: Math.floor((now - c.createdAt.getTime()) / 86400000),
    });
  }
  return out;
}
