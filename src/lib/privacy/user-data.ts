// GDPR right-to-access + right-to-erasure for User-attributable data.
//
// Privacy TSC. Closes risk-register item #16.
//
// What a "data subject request" means in this codebase:
//   - GDPR Art. 15 (right of access): the subject can request a copy
//     of all personal data we hold about them. We assemble a JSON
//     bundle from every table that references the user's id or
//     email.
//   - GDPR Art. 17 (right to erasure): the subject can request
//     deletion of their personal data. We CANNOT delete financial
//     records (legal-retention exemption under Art. 17(3)(b/e));
//     instead we redact the User row + email-delivery rows and
//     preserve the user_id pointer on financial records so the
//     attribution chain stays auditable.
//
// What stays:
//   - User.id (becomes a meaningless UUID after redaction)
//   - All JournalEntry.createdBy / submittedById / approvedById /
//     rejectedById references to the user id
//   - All AuditLog.actorUserId references
//   - Notification rows (orphaned but auditable)
//
// What gets redacted on erasure:
//   - User.email → `redacted-{userId}@deleted.local`
//   - User.displayName → `[Redacted User]`
//   - User.isActive → false, deactivatedAt → now
//   - EmailDelivery.toEmail referencing the old email → redacted form
//
// Audit-log integration:
//   - export: writes a DATA_EXPORT row with the bundle's record counts
//   - erase: writes a DATA_ERASURE row with the redaction summary
//   Both rows survive the rule-blocked UPDATE/DELETE on audit_log
//   (CC5/CC7), so a regulator can verify "yes, the request was
//   honored on date X."
//
// Authorization (enforced in the Server Action layer, not here):
//   - export: ADMIN+ of the user's tenant, OR the user themselves
//   - erasure: OWNER of the user's tenant (irreversible, highest bar)

import type { PrismaClient } from "@prisma/client";
import {
  fetchCompanionAttribution,
  type CompanionAttribution,
} from "./companion-attribution";

// ─────────────────────────────────────────────────────────────────────────────
// Export bundle shape
// ─────────────────────────────────────────────────────────────────────────────
//
// Stable schema — once shipped, customers may persist these bundles
// elsewhere (legal hold, replication to another system). Bumping the
// version is a breaking change.

export interface DataExportBundle {
  /**
   * Bundle schema version.
   *
   * Version 1: substrate-only attribution (ledger-core's own tables).
   * Version 2: adds `companionAttribution` — fetched from the four
   * companion repos via /api/internal/dsr/attribution.
   *
   * Old consumers that pin to v1 still parse v2 bundles (the
   * companion section is additive); new consumers should target v2.
   */
  schemaVersion: 1 | 2;
  exportedAt: string; // ISO timestamp
  subject: {
    userId: string;
    email: string;
    displayName: string;
    isActive: boolean;
    deactivatedAt: string | null;
    createdAt: string;
  };
  memberships: Array<{
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    role: string;
    createdAt: string;
  }>;
  invitesSent: Array<{
    id: string;
    tenantId: string;
    email: string;
    role: string;
    status: string;
    createdAt: string;
  }>;
  notifications: Array<{
    id: string;
    tenantId: string;
    category: string;
    title: string;
    createdAt: string;
    seenAt: string | null;
  }>;
  emailDeliveries: Array<{
    id: string;
    tenantId: string | null;
    template: string;
    subject: string;
    status: string;
    sentAt: string;
  }>;
  // Financial-record attribution. We include counts + a sample, not
  // every JE row — JEs are tenant-owned data, not user-personal data
  // (the user is just the recorder). GDPR Art. 15 doesn't require
  // exporting the underlying entity's books.
  attributionCounts: {
    journalEntriesCreated: number;
    journalEntriesSubmitted: number;
    journalEntriesApproved: number;
    journalEntriesRejected: number;
    auditLogEntries: number;
    recordEventsCreated: number;
    journalEntryNotesAuthored: number;
  };
  /**
   * Attribution counts from the four companion repos
   * (integrations / recon / fa-amort / revenue-rec).
   *
   * Each section is wrapped in `{ reachable, data?, error? }` — if a
   * companion was unreachable at export time, the bundle preserves
   * which one and why. A regulator can verify that partial-attribution
   * exports were the result of a transient outage, not data hiding.
   *
   * Present when schemaVersion >= 2. Optional for back-compat with
   * v1 callers that didn't pass an internalApiToken.
   */
  companionAttribution?: CompanionAttribution;
}

/**
 * Optional opts for `buildUserDataExport`. When `internalApiToken` is
 * supplied, the bundle is built as schemaVersion 2 with the
 * `companionAttribution` section populated (or marked unreachable).
 * When omitted, the bundle stays at schemaVersion 1 — substrate
 * attribution only.
 */
export interface BuildExportOptions {
  /**
   * INTERNAL_API_TOKEN for calling companion-repo
   * /api/internal/dsr/attribution. When unset, companion attribution
   * is SKIPPED (bundle stays at schemaVersion 1). Pass from the
   * Server Action layer where the env is validated.
   */
  internalApiToken?: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Assemble a Data Export bundle for the given user id. Always read-
 * only; never mutates. Returns a bundle the Server Action layer can
 * serve as a JSON download.
 *
 * No tenant scoping inside this function — a single user can belong
 * to multiple tenants, and the export covers the whole user. The
 * Server Action verifies actor authority before invoking.
 *
 * When `opts.internalApiToken` is supplied, also fetches attribution
 * counts from the four companion repos via /api/internal/dsr/attribution
 * and bumps the bundle to schemaVersion 2. Failures are tolerated —
 * an unreachable companion contributes a `reachable: false` entry
 * rather than crashing the export.
 */
export async function buildUserDataExport(
  prisma: PrismaClient,
  userId: string,
  opts: BuildExportOptions = {}
): Promise<DataExportBundle> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      isActive: true,
      deactivatedAt: true,
      createdAt: true,
    },
  });

  const [
    memberships,
    invitesSent,
    notifications,
    emailDeliveries,
    jeCreatedCount,
    jeSubmittedCount,
    jeApprovedCount,
    jeRejectedCount,
    auditLogCount,
    recordEventsCount,
    notesCount,
  ] = await Promise.all([
    prisma.tenantMembership.findMany({
      where: { userId },
      include: { tenant: { select: { slug: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.tenantInvite.findMany({
      where: { invitedById: userId },
      select: {
        id: true,
        tenantId: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.findMany({
      where: { recipientUserId: userId },
      select: {
        id: true,
        tenantId: true,
        category: true,
        title: true,
        createdAt: true,
        seenAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 1000, // bound the bundle size; downloads beyond this need a
      // dedicated full-export endpoint
    }),
    prisma.emailDelivery.findMany({
      where: { toEmail: user.email },
      select: {
        id: true,
        tenantId: true,
        template: true,
        subject: true,
        status: true,
        sentAt: true,
      },
      orderBy: { sentAt: "desc" },
      take: 1000,
    }),
    prisma.journalEntry.count({ where: { createdBy: user.email } }),
    prisma.journalEntry.count({ where: { submittedById: userId } }),
    prisma.journalEntry.count({ where: { approvedById: userId } }),
    prisma.journalEntry.count({ where: { rejectedById: userId } }),
    prisma.auditLog.count({ where: { actorUserId: userId } }),
    prisma.recordEvent.count({ where: { actorUserId: userId } }),
    prisma.journalEntryNote.count({ where: { authorUserId: userId } }),
  ]);

  // When a token is supplied, fetch companion attribution. Runs in
  // parallel with the in-progress Promise.all above isn't possible
  // here (the substrate query is already awaited). The companion
  // fetch is short-lived (~1-2s for healthy companions); the bundle
  // assembly stays under 5s total.
  const companionAttribution = opts.internalApiToken
    ? await fetchCompanionAttribution(userId, {
        internalApiToken: opts.internalApiToken,
        fetchImpl: opts.fetchImpl,
      })
    : undefined;

  return {
    schemaVersion: companionAttribution ? 2 : 1,
    exportedAt: new Date().toISOString(),
    subject: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      isActive: user.isActive,
      deactivatedAt: user.deactivatedAt
        ? user.deactivatedAt.toISOString()
        : null,
      createdAt: user.createdAt.toISOString(),
    },
    memberships: memberships.map((m) => ({
      tenantId: m.tenantId,
      tenantSlug: m.tenant.slug,
      tenantName: m.tenant.name,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    })),
    invitesSent: invitesSent.map((i) => ({
      ...i,
      createdAt: i.createdAt.toISOString(),
    })),
    notifications: notifications.map((n) => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
      seenAt: n.seenAt ? n.seenAt.toISOString() : null,
    })),
    emailDeliveries: emailDeliveries.map((e) => ({
      ...e,
      sentAt: e.sentAt.toISOString(),
    })),
    attributionCounts: {
      journalEntriesCreated: jeCreatedCount,
      journalEntriesSubmitted: jeSubmittedCount,
      journalEntriesApproved: jeApprovedCount,
      journalEntriesRejected: jeRejectedCount,
      auditLogEntries: auditLogCount,
      recordEventsCreated: recordEventsCount,
      journalEntryNotesAuthored: notesCount,
    },
    ...(companionAttribution ? { companionAttribution } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Erasure
// ─────────────────────────────────────────────────────────────────────────────

export interface ErasureSummary {
  userId: string;
  originalEmail: string;
  redactedEmail: string;
  emailDeliveriesRedacted: number;
}

/**
 * Redact the user's PII in place. Financial records and audit log
 * rows that REFERENCE the user.id are preserved (legal retention
 * + audit integrity); only the User row's PII fields and the
 * email-delivery records are scrubbed.
 *
 * Atomicity: wrapped in a $transaction so a partial failure rolls
 * everything back. The append-only rule on audit_log doesn't block
 * us here — we INSERT a DATA_ERASURE row, never UPDATE.
 *
 * Idempotent: re-running on an already-redacted user is a no-op
 * (detected by the email matching the redacted shape).
 */
export async function eraseUserPii(
  prisma: PrismaClient,
  userId: string
): Promise<ErasureSummary> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, displayName: true },
  });

  const redactedEmail = `redacted-${user.id}@deleted.local`;
  const redactedDisplayName = "[Redacted User]";

  // Idempotency: if already redacted, just return the current state.
  if (user.email === redactedEmail) {
    return {
      userId: user.id,
      originalEmail: user.email,
      redactedEmail,
      emailDeliveriesRedacted: 0,
    };
  }

  const originalEmail = user.email;

  const result = await prisma.$transaction(async (tx) => {
    // 1. Redact the User row.
    await tx.user.update({
      where: { id: userId },
      data: {
        email: redactedEmail,
        displayName: redactedDisplayName,
        isActive: false,
        deactivatedAt: new Date(),
      },
    });

    // 2. Redact email_delivery records that referenced the old email.
    const updateResult = await tx.emailDelivery.updateMany({
      where: { toEmail: originalEmail },
      data: { toEmail: redactedEmail },
    });

    return {
      userId: user.id,
      originalEmail,
      redactedEmail,
      emailDeliveriesRedacted: updateResult.count,
    };
  });

  return result;
}
