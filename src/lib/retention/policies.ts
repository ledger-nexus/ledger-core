// Declarative retention policies for the ledger-core substrate.
//
// SOC 2 CC6 + Privacy TSC. The data-classification policy
// (docs/policies/data-classification.md → "Retention" section) says
// what each table's retention period should be; this file is the
// EXECUTABLE form of that policy. The cron at
// src/app/api/cron/retention/route.ts walks this list once per day and
// hard-deletes rows whose retention window has passed.
//
// What's deliberately NOT in this list, and why:
//   - audit_log:       7-year SOC 2 retention. Also protected by a DB-
//                      level append-only RULE that silently no-ops
//                      DELETEs. Listing it here would create false
//                      confidence in the cron output.
//   - journal_entry:   Indefinite — financial records.
//   - period_close:    Indefinite — sealed-period evidence.
//   - record_event:    7-year retention. Will need its own policy with
//                      a longer cutoff once the volume justifies the
//                      complexity; for now, keep.
//   - ai_*_suggestion: 7-year retention for AI audit-trail purposes.
//
// Add a row here ONLY when:
//   1. The data-classification doc gives the column an explicit
//      retention window.
//   2. The retention window is shorter than the SOC 2 audit window
//      (otherwise just leave the rows in place — Neon storage is
//      cheap, compliance is not).
//   3. There's no FK from a long-retention table back to this row
//      (the cascade would either fail or destroy the referencing row,
//      neither of which is desired).
//
// Each policy must be IDEMPOTENT and SAFE TO RE-RUN. The cron may
// fire twice in a row if a deploy interleaves with a Vercel re-trigger;
// the policy must handle that without double-counting or skipping.

import type { PrismaClient } from "@prisma/client";

export interface RetentionPolicy {
  /**
   * Stable identifier — used in the audit-log row and the
   * per-policy counter output. Must NOT change once shipped, or the
   * audit history breaks continuity.
   */
  id: string;
  /** Human description for the audit-log metadata. */
  description: string;
  /** Retention window. Rows where the relevant timestamp is older than
   *  this get deleted. */
  retentionDays: number;
  /**
   * Run the policy and return the count of rows deleted. MUST NOT
   * throw — wrap any DB error and return 0 with the error logged via
   * the caller's `sanitizeError()` path.
   */
  purge: (prisma: PrismaClient, cutoff: Date) => Promise<number>;
}

export const RETENTION_POLICIES: ReadonlyArray<RetentionPolicy> = [
  {
    id: "notification.seen",
    description:
      "Notification rows the user marked seen > 365 days ago. After a " +
      "year the row has no monitoring value and shouldn't keep PII " +
      "(title/body — both encrypted at rest, still don't keep them " +
      "around longer than needed).",
    retentionDays: 365,
    purge: async (prisma, cutoff) => {
      const result = await prisma.notification.deleteMany({
        where: { seenAt: { not: null, lt: cutoff } },
      });
      return result.count;
    },
  },
  {
    id: "notification.unseen_stale",
    description:
      "Notification rows that are STILL UNSEEN but > 730 days old. If " +
      "the user hasn't clicked the bell in two years the notification " +
      "has lost its operational purpose; remove the row to bound PII " +
      "exposure. Bound is generous because unseen + old is the rarer " +
      "and lower-confidence case.",
    retentionDays: 730,
    purge: async (prisma, cutoff) => {
      const result = await prisma.notification.deleteMany({
        where: { seenAt: null, createdAt: { lt: cutoff } },
      });
      return result.count;
    },
  },
  {
    id: "tenant_invite.terminal",
    description:
      "Invites that are ACCEPTED, REVOKED, or expired > 30 days ago. " +
      "Once an invite is in a terminal state, the email + token are no " +
      "longer functional; keeping them is unnecessary PII exposure.",
    retentionDays: 30,
    purge: async (prisma, cutoff) => {
      // Three independent conditions:
      //   - accepted > 30 days ago
      //   - revoked > 30 days ago
      //   - expired > 30 days ago AND status still PENDING (auto-expiry
      //     timed out, never accepted, never explicitly revoked)
      const result = await prisma.tenantInvite.deleteMany({
        where: {
          OR: [
            { acceptedAt: { not: null, lt: cutoff } },
            { revokedAt: { not: null, lt: cutoff } },
            { status: "PENDING", expiresAt: { lt: cutoff } },
          ],
        },
      });
      return result.count;
    },
  },
  {
    id: "email_delivery.transient",
    description:
      "EmailDelivery rows older than 90 days. Email content (subject + " +
      "body) is the transient artifact of the send; the relationship to " +
      "the originating event (JE post, invite, owner-transfer) survives " +
      "via metadata in audit_log. sentAt is the canonical timestamp — " +
      "set to now() on insert per schema default.",
    retentionDays: 90,
    purge: async (prisma, cutoff) => {
      const result = await prisma.emailDelivery.deleteMany({
        where: { sentAt: { lt: cutoff } },
      });
      return result.count;
    },
  },
];

export type RetentionResult = {
  policyId: string;
  rowsDeleted: number;
  durationMs: number;
  error?: string;
};
