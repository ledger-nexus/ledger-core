// Declarative retention policies — the executable form of the retention
// table in docs/policies/data-classification.md.
//
// SOC 2 CC6 + Privacy TSC. A written retention policy that nothing
// enforces is the gap an auditor finds immediately: the document says
// "90 days" and the table has rows from eighteen months ago. This file
// is what makes the document true.
//
// Everything here HARD-DELETES. That is the point — a soft delete
// leaves the PII in the row. Which is also why the list is short and
// each entry has to argue for itself.
//
// What is deliberately NOT in this list, and why:
//
//   audit_log        7-year SOC 2 retention, and protected by a DB-level
//                    append-only RULE that silently no-ops DELETE. A
//                    policy here would report "0 rows deleted" forever
//                    and read as working. Worse than absent.
//   journal_entry    Financial records. Indefinite.
//   period_close     Sealed-period evidence. Indefinite.
//   record_event     7-year retention; keep.
//   user             Never purged on a timer. User PII leaves through the
//                    DSR erasure path (src/lib/privacy/user-data.ts),
//                    which is deliberate, audited, and OWNER-gated. A
//                    cron that deletes users on a schedule is how you
//                    lose the actor pointer on a financial record.
//
// Add a row ONLY when all four hold:
//
//   1. docs/policies/data-classification.md gives the data an explicit
//      retention window.
//   2. That window is shorter than the SOC 2 audit window — otherwise
//      keep the rows. Storage is cheap; a compliance gap is not.
//   3. Nothing holds a foreign key to the row. Verified for all four
//      policies below: no model in schema.prisma references
//      Notification, TenantInvite, or EmailDelivery.
//   4. The delete is idempotent and safe to re-run. The cron can fire
//      twice if a deploy interleaves with a Vercel re-trigger, and a
//      second run must simply find nothing left to do.

import type { PrismaClient } from "@prisma/client";

export interface RetentionPolicy {
  /**
   * Stable identifier. Appears in the audit-log row for every run, so
   * changing it after ship breaks the continuity of the evidence
   * trail an auditor walks. Treat as append-only.
   */
  id: string;
  /** Why this window, for the audit-log metadata and the reviewer. */
  description: string;
  /** Rows whose relevant timestamp is older than this are deleted. */
  retentionDays: number;
  /**
   * Delete and return the row count. May throw — the runner isolates
   * each policy so one failure cannot stop the others.
   */
  purge: (prisma: PrismaClient, cutoff: Date) => Promise<number>;
}

export const RETENTION_POLICIES: ReadonlyArray<RetentionPolicy> = [
  {
    id: "notification.seen",
    description:
      "Notifications the recipient marked seen more than a year ago. " +
      "Once seen and stale, the row has no operational value, and its " +
      "title/body carry tenant-identifying text.",
    retentionDays: 365,
    purge: async (prisma, cutoff) => {
      const { count } = await prisma.notification.deleteMany({
        where: { seenAt: { not: null, lt: cutoff } },
      });
      return count;
    },
  },
  {
    id: "notification.unseen_stale",
    description:
      "Notifications still UNSEEN after two years. If nobody has opened " +
      "the bell in that long the alert has lost its purpose. The window " +
      "is deliberately double the seen case: unseen means we never " +
      "confirmed anyone read it, so we wait longer before destroying it.",
    retentionDays: 730,
    purge: async (prisma, cutoff) => {
      const { count } = await prisma.notification.deleteMany({
        where: { seenAt: null, createdAt: { lt: cutoff } },
      });
      return count;
    },
  },
  {
    id: "tenant_invite.terminal",
    description:
      "Invites in a terminal state for more than 30 days — accepted, " +
      "revoked, or expired while still pending. The token is dead in " +
      "every one of those states; the row is then just an email address " +
      "we have no further use for.",
    retentionDays: 30,
    purge: async (prisma, cutoff) => {
      const { count } = await prisma.tenantInvite.deleteMany({
        where: {
          OR: [
            { acceptedAt: { not: null, lt: cutoff } },
            { revokedAt: { not: null, lt: cutoff } },
            // Timed out without ever being accepted or explicitly
            // revoked. expiresAt is the operative date, not createdAt:
            // the row stops being useful when the token dies.
            { status: "PENDING", expiresAt: { lt: cutoff } },
          ],
        },
      });
      return count;
    },
  },
  {
    id: "email_delivery.transient",
    description:
      "EmailDelivery rows older than 90 days. Subject and body are the " +
      "transient artifact of a send; the fact that the send happened " +
      "survives in audit_log. Keeping recipient addresses and message " +
      "bodies past the window we can actually need them for is exactly " +
      "the over-retention the Privacy TSC asks about.",
    retentionDays: 90,
    purge: async (prisma, cutoff) => {
      const { count } = await prisma.emailDelivery.deleteMany({
        where: { sentAt: { lt: cutoff } },
      });
      return count;
    },
  },
];

export interface RetentionResult {
  policyId: string;
  rowsDeleted: number;
  durationMs: number;
  /** Sanitized message when the policy threw. Absent on success. */
  error?: string;
}
