// BlackLine arc — Phase 1 PR 2: Reconciliation Server Actions.
//
// Six actions covering the recon lifecycle:
//
//   openReconciliation     OPEN row exists / created. Idempotent.
//   markPrepared           preparer signs; advances to PREPARED OR
//                          (single sign-off + within tolerance) directly
//                          to RECONCILED
//   approveRecon           reviewer signs; PREPARED → RECONCILED.
//                          Strict segregation of duties: reviewer ≠ preparer
//   sendBackToPreparer     reviewer rejects; PREPARED → IN_PROGRESS
//   markException          either signer flags an unresolvable diff;
//                          any non-terminal status → EXCEPTION
//   waiveRecon             admin marks not-applicable for this period.
//                          Any status → WAIVED (terminal)
//
// SOC 2 baseline (per the global CLAUDE.md):
//   - CC6.3 Authorization: every action requires a signed-in user with
//     a current tenant. `waiveRecon` additionally requires admin.
//   - CC6.1 Multi-tenant: every read + write is tenant-scoped via
//     `findFirst({ where: { tenantId, ... }})`. Cross-tenant attempts
//     return "not found" rather than leaking existence.
//   - CC6.8 Input validation: every input has a Zod schema. Invalid
//     input returns a structured error; no DB write happens.
//   - CC7.2 Audit: every successful mutation writes a
//     PRIVILEGED_ACTION row. Failures (auth, validation, status
//     mismatch) do not — they're rejected before any state changes.
//
// Strict segregation of duties on reviewer: reviewer.id ≠ preparer.id.
// Small tenants who want one-person sign-off should set the recon's
// requiresReview to false at open time (see Account.requiresReconReview
// / ReconciliationConfig.defaultRequiresReview cascade).

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Decimal } from "@/lib/utils/decimal";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant, requireTenantAdmin } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { resolveReconDefaults } from "@/lib/recon/resolve-defaults";

// Zod helpers — uuid + currency-amount strings.
const uuid = z.string().uuid();
const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a numeric string")
  .refine((s) => {
    try {
      new Decimal(s);
      return true;
    } catch {
      return false;
    }
  }, "must parse as a Decimal");

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const OpenInput = z.object({
  entityId: uuid,
  bookId: uuid,
  periodId: uuid,
  accountId: uuid,
  // Caller supplies GL balance — typically from getTrialBalance at the
  // page level. PR 6 (auto-instantiate) computes this for all BS
  // accounts at once.
  glBalance: moneyString,
});

const MarkPreparedInput = z.object({
  reconId: uuid,
  // The "I checked these against support" certification numbers. GL
  // balance can be re-supplied if the operator wants to lock a different
  // snapshot than the one auto-pulled at open time (e.g. they refreshed
  // mid-prep after posting a correcting JE).
  glBalance: moneyString,
  supportingBalance: moneyString,
  notes: z.string().max(4000).optional(),
});

const ApproveInput = z.object({
  reconId: uuid,
});

const SendBackInput = z.object({
  reconId: uuid,
  comment: z.string().min(1).max(2000),
});

const ExceptionInput = z.object({
  reconId: uuid,
  comment: z.string().min(1).max(2000),
});

const WaiveInput = z.object({
  reconId: uuid,
  reason: z.string().min(1).max(2000),
});

export type ActionResult =
  | { ok: true; reconId: string }
  | { ok: false; error: string; code: string };

// Used across actions to format error responses consistently. Code is
// a stable identifier for the UI to switch on; error is human-friendly.
function fail(code: string, error: string): ActionResult {
  return { ok: false, code, error };
}

// ─────────────────────────────────────────────────────────────────────────
// openReconciliation
//
// Idempotent on (entityId, bookId, periodId, accountId). If a row
// already exists, returns it (no state change, no audit row). If not,
// creates a new OPEN row with cascade-resolved requiresReview +
// tolerance.
// ─────────────────────────────────────────────────────────────────────────
export async function openReconciliation(
  input: z.infer<typeof OpenInput>
): Promise<ActionResult> {
  const parsed = OpenInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const { entityId, bookId, periodId, accountId, glBalance } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  // Defensive cross-tenant guard: verify all four FK targets belong to
  // this tenant before creating the recon. Skip the recon-existence
  // check first — if all FKs resolve, the @@unique scope key collapses
  // to a single get-or-create.
  const [entity, book, period, account] = await Promise.all([
    prisma.legalEntity.findFirst({
      where: { id: entityId, tenantId: tenant.id },
      select: { id: true },
    }),
    prisma.book.findFirst({ where: { id: bookId }, select: { id: true } }),
    prisma.period.findFirst({
      where: { id: periodId, tenantId: tenant.id },
      select: { id: true },
    }),
    prisma.account.findFirst({
      where: { id: accountId, tenantId: tenant.id },
      select: { id: true },
    }),
  ]);
  if (!entity || !period || !account) {
    return fail("NOT_FOUND", "Entity, period, or account not in this tenant");
  }
  if (!book) {
    // Book is global (not tenant-scoped per the existing schema).
    return fail("NOT_FOUND", "Book not found");
  }

  // Resolve defaults from the cascade.
  const defaults = await resolveReconDefaults(prisma, tenant.id, accountId);

  // Get-or-create on the unique scope tuple.
  const existing = await prisma.reconciliation.findUnique({
    where: {
      entityId_bookId_periodId_accountId: {
        entityId,
        bookId,
        periodId,
        accountId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    // Idempotent: return existing without an audit row.
    return { ok: true, reconId: existing.id };
  }

  const gl = new Decimal(glBalance);
  const created = await prisma.reconciliation.create({
    data: {
      tenantId: tenant.id,
      entityId,
      bookId,
      periodId,
      accountId,
      glBalance: gl.toString() as unknown as Prisma.Decimal,
      tolerance: defaults.tolerance.toString() as unknown as Prisma.Decimal,
      requiresReview: defaults.requiresReview,
      status: "OPEN",
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.open",
    resource: "Reconciliation",
    resourceId: created.id,
    tenantId: tenant.id,
    metadata: {
      entityId,
      bookId,
      periodId,
      accountId,
      glBalance,
      requiresReview: defaults.requiresReview,
      tolerance: defaults.tolerance.toString(),
    },
  });

  revalidatePath("/close/reconciliations");
  return { ok: true, reconId: created.id };
}

// ─────────────────────────────────────────────────────────────────────────
// markPrepared
//
// Preparer signs. Branching:
//   requiresReview=true  → status PREPARED, waits for reviewer
//   requiresReview=false → status RECONCILED if diff within tolerance,
//                          EXCEPTION otherwise
// ─────────────────────────────────────────────────────────────────────────
export async function markPrepared(
  input: z.infer<typeof MarkPreparedInput>
): Promise<ActionResult> {
  const parsed = MarkPreparedInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const { reconId, glBalance, supportingBalance, notes } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const recon = await prisma.reconciliation.findFirst({
    where: { id: reconId, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      requiresReview: true,
      tolerance: true,
    },
  });
  if (!recon) {
    return fail("NOT_FOUND", "Reconciliation not found");
  }
  if (recon.status !== "OPEN" && recon.status !== "IN_PROGRESS") {
    return fail(
      "INVALID_STATUS",
      `Cannot mark prepared from status ${recon.status}`
    );
  }

  const gl = new Decimal(glBalance);
  const supporting = new Decimal(supportingBalance);
  const diff = gl.minus(supporting);
  const tolerance = new Decimal(recon.tolerance.toString());
  const withinTolerance = diff.abs().lessThanOrEqualTo(tolerance);

  let nextStatus: "PREPARED" | "RECONCILED" | "EXCEPTION";
  if (!withinTolerance) {
    // Outside tolerance always lands in EXCEPTION regardless of sign-off
    // mode. The preparer needs to resolve before either single-sign-off
    // self-completes or the reviewer can approve.
    nextStatus = "EXCEPTION";
  } else if (recon.requiresReview) {
    nextStatus = "PREPARED";
  } else {
    // Single sign-off, within tolerance — preparer's mark is final.
    nextStatus = "RECONCILED";
  }

  await prisma.reconciliation.update({
    where: { id: reconId },
    data: {
      glBalance: gl.toString() as unknown as Prisma.Decimal,
      supportingBalance: supporting.toString() as unknown as Prisma.Decimal,
      reconciledDiff: diff.toString() as unknown as Prisma.Decimal,
      notes: notes ?? null,
      status: nextStatus,
      preparedBy: user.id,
      preparedAt: new Date(),
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.prepare",
    resource: "Reconciliation",
    resourceId: reconId,
    tenantId: tenant.id,
    metadata: {
      glBalance,
      supportingBalance,
      diff: diff.toString(),
      tolerance: tolerance.toString(),
      requiresReview: recon.requiresReview,
      resultStatus: nextStatus,
    },
  });

  revalidatePath("/close/reconciliations");
  revalidatePath(`/close/reconciliations/${reconId}`);
  return { ok: true, reconId };
}

// ─────────────────────────────────────────────────────────────────────────
// approveRecon
//
// Reviewer signs. Status PREPARED → RECONCILED.
// Strict segregation of duties: reviewer.id ≠ preparer.id.
// ─────────────────────────────────────────────────────────────────────────
export async function approveRecon(
  input: z.infer<typeof ApproveInput>
): Promise<ActionResult> {
  const parsed = ApproveInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const { reconId } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const recon = await prisma.reconciliation.findFirst({
    where: { id: reconId, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      requiresReview: true,
      preparedBy: true,
    },
  });
  if (!recon) return fail("NOT_FOUND", "Reconciliation not found");
  if (recon.status !== "PREPARED") {
    return fail("INVALID_STATUS", `Cannot approve from status ${recon.status}`);
  }
  if (!recon.requiresReview) {
    // Single-sign-off recons should never reach PREPARED status; if
    // they somehow did (data drift), refuse.
    return fail(
      "INVALID_STATUS",
      "This recon was opened with single sign-off; approval doesn't apply"
    );
  }
  if (!recon.preparedBy) {
    return fail("INVALID_STATUS", "Cannot approve a recon with no preparer");
  }
  // CPA segregation of duties.
  if (recon.preparedBy === user.id) {
    return fail(
      "SAME_USER",
      "Reviewer must differ from preparer. To allow single sign-off on this account, set requiresReconReview=false."
    );
  }

  await prisma.reconciliation.update({
    where: { id: reconId },
    data: {
      status: "RECONCILED",
      reviewedBy: user.id,
      reviewedAt: new Date(),
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.approve",
    resource: "Reconciliation",
    resourceId: reconId,
    tenantId: tenant.id,
    metadata: { previousStatus: "PREPARED", newStatus: "RECONCILED" },
  });

  revalidatePath("/close/reconciliations");
  revalidatePath(`/close/reconciliations/${reconId}`);
  return { ok: true, reconId };
}

// ─────────────────────────────────────────────────────────────────────────
// sendBackToPreparer
//
// Reviewer rejects with a comment. Status PREPARED → IN_PROGRESS.
// Same segregation of duties check as approve.
// ─────────────────────────────────────────────────────────────────────────
export async function sendBackToPreparer(
  input: z.infer<typeof SendBackInput>
): Promise<ActionResult> {
  const parsed = SendBackInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const { reconId, comment } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const recon = await prisma.reconciliation.findFirst({
    where: { id: reconId, tenantId: tenant.id },
    select: { id: true, status: true, preparedBy: true },
  });
  if (!recon) return fail("NOT_FOUND", "Reconciliation not found");
  if (recon.status !== "PREPARED") {
    return fail(
      "INVALID_STATUS",
      `Cannot send back from status ${recon.status}`
    );
  }
  if (recon.preparedBy === user.id) {
    return fail(
      "SAME_USER",
      "Reviewer must differ from preparer."
    );
  }

  await prisma.reconciliation.update({
    where: { id: reconId },
    data: {
      status: "IN_PROGRESS",
      // Clear preparer state so the redo lands fresh. Reviewer fields
      // stay null (they never signed; we're rejecting, not approving).
      preparedBy: null,
      preparedAt: null,
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.send-back",
    resource: "Reconciliation",
    resourceId: reconId,
    tenantId: tenant.id,
    metadata: { comment, previousStatus: "PREPARED", newStatus: "IN_PROGRESS" },
  });

  revalidatePath("/close/reconciliations");
  revalidatePath(`/close/reconciliations/${reconId}`);
  return { ok: true, reconId };
}

// ─────────────────────────────────────────────────────────────────────────
// markException
//
// Preparer or reviewer flags an unresolvable diff. From any non-terminal
// status. The recon is NOT closed — it surfaces in the EXCEPTION bucket
// for disposition.
// ─────────────────────────────────────────────────────────────────────────
export async function markException(
  input: z.infer<typeof ExceptionInput>
): Promise<ActionResult> {
  const parsed = ExceptionInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const { reconId, comment } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const recon = await prisma.reconciliation.findFirst({
    where: { id: reconId, tenantId: tenant.id },
    select: { id: true, status: true },
  });
  if (!recon) return fail("NOT_FOUND", "Reconciliation not found");
  if (recon.status === "RECONCILED" || recon.status === "WAIVED") {
    return fail(
      "INVALID_STATUS",
      `Cannot mark exception on terminal status ${recon.status}`
    );
  }

  await prisma.reconciliation.update({
    where: { id: reconId },
    data: { status: "EXCEPTION" },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.exception",
    resource: "Reconciliation",
    resourceId: reconId,
    tenantId: tenant.id,
    metadata: {
      comment,
      previousStatus: recon.status,
      newStatus: "EXCEPTION",
    },
  });

  revalidatePath("/close/reconciliations");
  revalidatePath(`/close/reconciliations/${reconId}`);
  return { ok: true, reconId };
}

// ─────────────────────────────────────────────────────────────────────────
// waiveRecon
//
// Admin marks not-applicable for this period. From any status. Terminal.
// The audit row carries the reason for SOC 1 / SOX 404 evidence — an
// auditor needs to see WHY a balance-sheet account was excused from
// reconciliation in this period.
// ─────────────────────────────────────────────────────────────────────────
export async function waiveRecon(
  input: z.infer<typeof WaiveInput>
): Promise<ActionResult> {
  const parsed = WaiveInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const { reconId, reason } = parsed.data;

  const user = await requireCurrentUser();
  // Admin-only — escalates from requireCurrentTenant.
  const tenant = await requireTenantAdmin();

  const recon = await prisma.reconciliation.findFirst({
    where: { id: reconId, tenantId: tenant.id },
    select: { id: true, status: true },
  });
  if (!recon) return fail("NOT_FOUND", "Reconciliation not found");

  await prisma.reconciliation.update({
    where: { id: reconId },
    data: { status: "WAIVED" },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.waive",
    resource: "Reconciliation",
    resourceId: reconId,
    tenantId: tenant.id,
    metadata: { reason, previousStatus: recon.status, newStatus: "WAIVED" },
  });

  revalidatePath("/close/reconciliations");
  revalidatePath(`/close/reconciliations/${reconId}`);
  return { ok: true, reconId };
}
