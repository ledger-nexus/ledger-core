"use server";

// GDPR data-subject-request Server Actions. Two transitions:
//   exportUserDataAction(userId) — assembles the export bundle
//   eraseUserPiiAction(userId)   — redacts the user's PII in place
//
// Authorization:
//   - Export: ADMIN+ in any tenant the subject is a member of, OR the
//     subject themselves (they can request their own data without
//     admin involvement).
//   - Erasure: OWNER of any tenant the subject is a member of.
//     Irreversible — highest bar. Single-OWNER scenarios (which is
//     the typical solo-founder case) should escalate via the
//     procedure in docs/policies/data-classification.md before
//     invoking.
//
// Audit:
//   - export: DATA_EXPORT row with attribution counts
//   - erase: DATA_ERASURE row with the redaction summary
// Both rows survive forever (audit_log is append-only at the DB
// level). A regulator can verify the request was honored.

import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import {
  requireCurrentTenant,
  NoTenantSelectedError,
} from "@/lib/auth/tenant";
import {
  buildUserDataExport,
  eraseUserPii,
  type DataExportBundle,
  type ErasureSummary,
} from "@/lib/privacy/user-data";
import { logAuditEvent } from "@/lib/audit/log";

export interface DataSubjectActionState<TPayload = unknown> {
  ok: boolean;
  message?: string;
  payload?: TPayload;
}

// ─── exportUserDataAction ──────────────────────────────────────────────────

export async function exportUserDataAction(
  subjectUserId: string
): Promise<DataSubjectActionState<DataExportBundle>> {
  try {
    const actor = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // Authorization: actor is the subject themselves, OR actor is
    // ADMIN+ in a tenant the subject also belongs to.
    if (actor.id !== subjectUserId) {
      const cohabit = await prisma.tenantMembership.findFirst({
        where: {
          tenantId: tenant.id,
          userId: subjectUserId,
        },
        select: { id: true },
      });
      if (!cohabit) {
        return {
          ok: false,
          message: "You can only export data for a user in your tenant.",
        };
      }
      // role check: the actor's role on the current tenant must be ADMIN+
      // (canManageMemberships is the existing policy gate for that).
      const { canManageMemberships } = await import("@/lib/auth/policy");
      if (!canManageMemberships(tenant.role)) {
        return {
          ok: false,
          message:
            "Exporting another user's data requires ADMIN or OWNER role.",
        };
      }
    }

    const bundle = await buildUserDataExport(prisma, subjectUserId);

    await logAuditEvent({
      tenantId: tenant.id,
      actorUserId: actor.id,
      eventType: "DATA_EXPORT",
      action: "data_subject.export",
      resource: "User",
      resourceId: subjectUserId,
      outcome: "SUCCESS",
      metadata: {
        attributionCounts: bundle.attributionCounts,
        membershipCount: bundle.memberships.length,
        notificationCount: bundle.notifications.length,
        emailDeliveryCount: bundle.emailDeliveries.length,
        selfRequest: actor.id === subjectUserId,
      },
    });

    return {
      ok: true,
      message: `Exported ${bundle.memberships.length} memberships + ${bundle.notifications.length} notifications + ${bundle.emailDeliveries.length} email deliveries.`,
      payload: bundle,
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── eraseUserPiiAction ────────────────────────────────────────────────────

export async function eraseUserPiiAction(
  subjectUserId: string
): Promise<DataSubjectActionState<ErasureSummary>> {
  try {
    const actor = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    // Authorization: OWNER only. Erasure is irreversible.
    if (tenant.role !== "OWNER") {
      return {
        ok: false,
        message:
          "Erasing a user's PII requires OWNER role. Ask the workspace OWNER to handle this request.",
      };
    }

    // The subject must be a member of the actor's tenant. Cross-
    // tenant erasure (i.e., OWNER of tenant A erasing a user only
    // active in tenant B) is intentionally blocked.
    const cohabit = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenant.id, userId: subjectUserId },
      select: { id: true },
    });
    if (!cohabit) {
      return {
        ok: false,
        message: "The user is not a member of your workspace.",
      };
    }

    // Prevent self-erasure as OWNER — they'd lose access to the
    // workspace afterward. The user should transfer ownership first.
    if (actor.id === subjectUserId) {
      return {
        ok: false,
        message:
          "An OWNER cannot erase their own PII. Transfer ownership first, then ask the new OWNER to process the request.",
      };
    }

    const summary = await eraseUserPii(prisma, subjectUserId);

    await logAuditEvent({
      tenantId: tenant.id,
      actorUserId: actor.id,
      eventType: "DATA_ERASURE",
      action: "data_subject.erase",
      resource: "User",
      resourceId: subjectUserId,
      outcome: "SUCCESS",
      metadata: {
        originalEmailHash: hashEmailForAudit(summary.originalEmail),
        redactedEmail: summary.redactedEmail,
        emailDeliveriesRedacted: summary.emailDeliveriesRedacted,
      },
    });

    return {
      ok: true,
      message: `Erased PII for user ${subjectUserId.slice(0, 8)}… (${summary.emailDeliveriesRedacted} email deliveries also redacted). The user can no longer sign in.`,
      payload: summary,
    };
  } catch (e) {
    return mapError(e);
  }
}

// Hash the original email so the audit row records "we erased user
// with email hash X" without preserving the email itself in clear
// text — the point of erasure is to remove the PII everywhere.
function hashEmailForAudit(email: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("node:crypto");
  return crypto
    .createHash("sha256")
    .update(email.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function mapError<T>(e: unknown): DataSubjectActionState<T> {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: e instanceof Error ? e.message : "Unknown error",
  };
}
