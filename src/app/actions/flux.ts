// BlackLine arc — Phase 3 PR 2: flux Server Actions.
//
// Four actions covering the flux lifecycle:
//
//   generateFluxStatement  Computes the flux via getFluxAnalysis and
//                          upserts the FluxStatement + FluxLine rows.
//                          Idempotent via the @@unique on (entity,
//                          book, from, to).
//   addFluxLineCommentary  Records the controller's explanation on a
//                          material line. Status flips to EXPLAINED.
//   waiveFluxLine          Admin-only. Marks a material line as
//                          WAIVED with a mandatory reason.
//   finalizeFluxStatement  Locks the statement (DRAFT → FINALIZED).
//                          Refuses if any line remains NEEDS_COMMENT.
//
// SOC 2 baseline:
//   CC6.1 every read + write tenant-scoped.
//   CC6.3 every action requires user + tenant. waiveFluxLine +
//         finalizeFluxStatement require admin.
//   CC6.8 Zod on every input.
//   CC7.2 PRIVILEGED_ACTION row per successful mutation. Per-row
//         audit on commentary actions (each line is its own evidence
//         exhibit); ONE aggregate row on generateFluxStatement
//         (N lines × N audit rows would balloon the log).

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import {
  requireCurrentTenant,
  requireTenantAdmin,
} from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { getFluxAnalysis } from "@/lib/flux/get-flux-analysis";

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────
const uuid = z.string().uuid();
const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a numeric string");

const GenerateInput = z.object({
  entityCode: z.string().min(1).max(50),
  bookCode: z.string().min(1).max(20),
  fromPeriodCode: z.string().min(1).max(30),
  toPeriodCode: z.string().min(1).max(30),
  absoluteThreshold: moneyString, // e.g. "5000.00"
  percentThreshold: moneyString, // e.g. "10.00" (10%)
});

const CommentaryInput = z.object({
  lineId: uuid,
  commentary: z.string().min(1).max(4000),
});

const WaiveInput = z.object({
  lineId: uuid,
  reason: z.string().min(1).max(2000),
});

const FinalizeInput = z.object({
  statementId: uuid,
});

export type FluxResult =
  | { ok: true; statementId?: string; lineId?: string }
  | { ok: false; code: string; error: string };

export type GenerateResult =
  | {
      ok: true;
      statementId: string;
      totalLines: number;
      materialLines: number;
    }
  | { ok: false; code: string; error: string };

export type FinalizeResult =
  | { ok: true; statementId: string }
  | {
      ok: false;
      code: string;
      error: string;
      /** Populated on FINALIZE_GATE_BLOCKED so the UI can list what's missing. */
      pendingLines?: { id: string; accountCode: string; accountName: string }[];
    };

function fail(code: string, error: string): FluxResult {
  return { ok: false, code, error };
}

// ═════════════════════════════════════════════════════════════════════════
// generateFluxStatement
//
// Resolves the (entity, book, from, to) tuple, runs getFluxAnalysis,
// upserts the FluxStatement, and replaces the FluxLine set in a
// transaction. Idempotent: re-running on the same tuple refreshes the
// line snapshots against the current GL but doesn't duplicate the
// statement.
//
// Threshold tightening: re-running with a tighter threshold updates
// the statement's threshold AND each line's status. EXPLAINED lines
// retain their commentary even if they drop to IMMATERIAL — the
// audit trail of "I looked at this and noted X" is preserved.
// ═════════════════════════════════════════════════════════════════════════
export async function generateFluxStatement(
  input: z.infer<typeof GenerateInput>
): Promise<GenerateResult> {
  const parsed = GenerateInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      error: parsed.error.errors[0]?.message ?? "Invalid input",
    };
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const {
    entityCode,
    bookCode,
    fromPeriodCode,
    toPeriodCode,
    absoluteThreshold,
    percentThreshold,
  } = parsed.data;

  // Resolve FKs — every lookup tenant-scoped.
  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId: tenant.id, code: entityCode },
    select: { id: true, code: true },
  });
  if (!entity) {
    return {
      ok: false,
      code: "NOT_FOUND",
      error: `Entity not found in this tenant: ${entityCode}`,
    };
  }
  const book = await prisma.book.findUnique({
    where: { code: bookCode },
    select: { id: true, code: true },
  });
  if (!book) {
    return { ok: false, code: "NOT_FOUND", error: `Book not found: ${bookCode}` };
  }
  const [fromPeriod, toPeriod] = await Promise.all([
    prisma.period.findFirst({
      where: {
        tenantId: tenant.id,
        code: fromPeriodCode,
        calendar: { entityId: entity.id },
      },
      select: { id: true, endsOn: true, code: true },
    }),
    prisma.period.findFirst({
      where: {
        tenantId: tenant.id,
        code: toPeriodCode,
        calendar: { entityId: entity.id },
      },
      select: { id: true, endsOn: true, code: true },
    }),
  ]);
  if (!fromPeriod || !toPeriod) {
    return {
      ok: false,
      code: "NOT_FOUND",
      error: "From or To period not found for this entity",
    };
  }
  if (fromPeriod.id === toPeriod.id) {
    return {
      ok: false,
      code: "INVALID_RANGE",
      error: "fromPeriod and toPeriod must be different",
    };
  }

  // Run the pure-helper analysis. This is the read half; the write
  // half is the transaction below.
  const analysis = await getFluxAnalysis(prisma, {
    tenantId: tenant.id,
    entityCode: entity.code,
    bookCode: book.code,
    asOfPrior: fromPeriod.endsOn,
    asOfCurrent: toPeriod.endsOn,
    absoluteThreshold: new Decimal(absoluteThreshold),
    percentThreshold: new Decimal(percentThreshold),
  });

  // Upsert + replace-lines in one transaction. Existing lines on a
  // re-run get DELETE'd via the cascade-from-statement, but the
  // statement is what we want to keep — so we only delete the LINES
  // and recreate them. EXPLAINED commentary survives across re-runs
  // via the per-line restoration step.
  const result = await prisma.$transaction(async (tx) => {
    // Get-or-create the statement.
    const statement = await tx.fluxStatement.upsert({
      where: {
        entityId_bookId_fromPeriodId_toPeriodId: {
          entityId: entity.id,
          bookId: book.id,
          fromPeriodId: fromPeriod.id,
          toPeriodId: toPeriod.id,
        },
      },
      create: {
        tenantId: tenant.id,
        entityId: entity.id,
        bookId: book.id,
        fromPeriodId: fromPeriod.id,
        toPeriodId: toPeriod.id,
        absoluteThreshold: absoluteThreshold as unknown as Prisma.Decimal,
        percentThreshold: percentThreshold as unknown as Prisma.Decimal,
        status: "DRAFT",
      },
      update: {
        absoluteThreshold: absoluteThreshold as unknown as Prisma.Decimal,
        percentThreshold: percentThreshold as unknown as Prisma.Decimal,
        // FINALIZED → re-running RESETS to DRAFT. Threshold tightening
        // legitimately invalidates a prior signoff because the
        // material set may have changed. Auditor sees the regen
        // event in the audit log.
        status: "DRAFT",
        finalizedBy: null,
        finalizedAt: null,
      },
      select: { id: true },
    });

    // Pull existing line commentary so we can preserve it across the
    // replace. Keyed by accountId.
    const existing = await tx.fluxLine.findMany({
      where: { statementId: statement.id },
      select: {
        accountId: true,
        commentary: true,
        commentaryBy: true,
        commentaryAt: true,
        status: true,
      },
    });
    const commentaryByAccount = new Map(
      existing.map((e) => [
        e.accountId,
        {
          commentary: e.commentary,
          commentaryBy: e.commentaryBy,
          commentaryAt: e.commentaryAt,
          previousStatus: e.status,
        },
      ])
    );

    // Delete + recreate lines. Cascade is configured on the statement,
    // but we manually clear to keep the statement row intact.
    await tx.fluxLine.deleteMany({ where: { statementId: statement.id } });

    // Recreate via createMany (no commentary in this batch), then
    // patch commentary back in a second pass for accounts that had
    // explanation prior to the re-run.
    if (analysis.lines.length > 0) {
      await tx.fluxLine.createMany({
        data: analysis.lines.map((l) => ({
          tenantId: tenant.id,
          statementId: statement.id,
          accountId: l.accountId,
          priorAmount: l.priorAmount.toString() as unknown as Prisma.Decimal,
          currentAmount: l.currentAmount.toString() as unknown as Prisma.Decimal,
          deltaAmount: l.deltaAmount.toString() as unknown as Prisma.Decimal,
          deltaPercent:
            l.deltaPercent !== null
              ? (l.deltaPercent.toString() as unknown as Prisma.Decimal)
              : null,
          status: l.status,
        })),
      });

      // Restore commentary on accounts that had it. Status:
      //   - was EXPLAINED + still material → keep EXPLAINED
      //   - was EXPLAINED + now IMMATERIAL → keep EXPLAINED
      //     (commentary still valuable as audit evidence)
      //   - was WAIVED → keep WAIVED (admin signoff doesn't expire)
      const reconciledIds = await tx.fluxLine.findMany({
        where: { statementId: statement.id },
        select: { id: true, accountId: true, status: true },
      });
      for (const line of reconciledIds) {
        const prior = commentaryByAccount.get(line.accountId);
        if (!prior) continue;
        if (
          prior.previousStatus === "EXPLAINED" ||
          prior.previousStatus === "WAIVED"
        ) {
          await tx.fluxLine.update({
            where: { id: line.id },
            data: {
              status: prior.previousStatus,
              commentary: prior.commentary,
              commentaryBy: prior.commentaryBy,
              commentaryAt: prior.commentaryAt,
            },
          });
        }
      }
    }

    return statement.id;
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "flux.statement.generate",
    resource: "FluxStatement",
    resourceId: result,
    tenantId: tenant.id,
    metadata: {
      entityCode,
      bookCode,
      fromPeriodCode,
      toPeriodCode,
      absoluteThreshold,
      percentThreshold,
      totalLines: analysis.totalLines,
      materialLines: analysis.materialLines,
    },
  });

  revalidatePath(`/close/flux`);
  revalidatePath(`/close/flux/${result}`);

  return {
    ok: true,
    statementId: result,
    totalLines: analysis.totalLines,
    materialLines: analysis.materialLines,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// addFluxLineCommentary
//
// Sets EXPLAINED + commentary on a material line. Returns WRONG_STATUS
// when the line is IMMATERIAL (no commentary needed) or WAIVED (admin
// already excused it). FINALIZED statement → refused.
// ─────────────────────────────────────────────────────────────────────────
export async function addFluxLineCommentary(
  input: z.infer<typeof CommentaryInput>
): Promise<FluxResult> {
  const parsed = CommentaryInput.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      parsed.error.errors[0]?.message ?? "Invalid input"
    );
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const line = await prisma.fluxLine.findFirst({
    where: { id: parsed.data.lineId, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      statementId: true,
      statement: { select: { status: true } },
    },
  });
  if (!line) return fail("NOT_FOUND", "Flux line not found");
  if (line.statement.status === "FINALIZED") {
    return fail("STATEMENT_FINALIZED", "Cannot edit a finalized statement");
  }
  if (line.status === "IMMATERIAL") {
    return fail(
      "WRONG_STATUS",
      "Line is below the materiality threshold — no commentary needed"
    );
  }
  if (line.status === "WAIVED") {
    return fail("WRONG_STATUS", "Line is waived — commentary already excused");
  }

  await prisma.fluxLine.update({
    where: { id: line.id },
    data: {
      status: "EXPLAINED",
      commentary: parsed.data.commentary.trim(),
      commentaryBy: user.id,
      commentaryAt: new Date(),
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "flux.line.commentary",
    resource: "FluxLine",
    resourceId: line.id,
    tenantId: tenant.id,
    metadata: {
      statementId: line.statementId,
      previousStatus: line.status,
      length: parsed.data.commentary.trim().length,
    },
  });
  revalidatePath(`/close/flux/${line.statementId}`);
  return { ok: true, lineId: line.id };
}

// ─────────────────────────────────────────────────────────────────────────
// waiveFluxLine
//
// Admin-only. Marks a material line as WAIVED with reason. Reason
// stored in commentary (prefixed "WAIVED: ") mirroring the
// close-task waive pattern so one renderer handles both EXPLAINED
// and WAIVED commentary.
// ─────────────────────────────────────────────────────────────────────────
export async function waiveFluxLine(
  input: z.infer<typeof WaiveInput>
): Promise<FluxResult> {
  const parsed = WaiveInput.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      parsed.error.errors[0]?.message ?? "Invalid input"
    );
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();
  try {
    await requireTenantAdmin();
  } catch {
    return fail("NOT_ADMIN", "Only a tenant admin can waive a flux line");
  }

  const line = await prisma.fluxLine.findFirst({
    where: { id: parsed.data.lineId, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      statementId: true,
      statement: { select: { status: true } },
    },
  });
  if (!line) return fail("NOT_FOUND", "Flux line not found");
  if (line.statement.status === "FINALIZED") {
    return fail("STATEMENT_FINALIZED", "Cannot edit a finalized statement");
  }
  if (line.status === "IMMATERIAL") {
    return fail(
      "WRONG_STATUS",
      "Line is below the materiality threshold — no waiver needed"
    );
  }

  await prisma.fluxLine.update({
    where: { id: line.id },
    data: {
      status: "WAIVED",
      commentary: `WAIVED: ${parsed.data.reason.trim()}`,
      commentaryBy: user.id,
      commentaryAt: new Date(),
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "flux.line.waive",
    resource: "FluxLine",
    resourceId: line.id,
    tenantId: tenant.id,
    metadata: {
      statementId: line.statementId,
      previousStatus: line.status,
      reason: parsed.data.reason.trim(),
    },
  });
  revalidatePath(`/close/flux/${line.statementId}`);
  return { ok: true, lineId: line.id };
}

// ─────────────────────────────────────────────────────────────────────────
// finalizeFluxStatement
//
// Admin-only. DRAFT → FINALIZED. Refuses if any line remains
// NEEDS_COMMENT — the gate that makes the workflow meaningful.
// ─────────────────────────────────────────────────────────────────────────
export async function finalizeFluxStatement(
  input: z.infer<typeof FinalizeInput>
): Promise<FinalizeResult> {
  const parsed = FinalizeInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      error: parsed.error.errors[0]?.message ?? "Invalid input",
    };
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();
  try {
    await requireTenantAdmin();
  } catch {
    return {
      ok: false,
      code: "NOT_ADMIN",
      error: "Only a tenant admin can finalize a flux statement",
    };
  }

  const stmt = await prisma.fluxStatement.findFirst({
    where: { id: parsed.data.statementId, tenantId: tenant.id },
    select: { id: true, status: true },
  });
  if (!stmt) {
    return { ok: false, code: "NOT_FOUND", error: "Statement not found" };
  }
  if (stmt.status === "FINALIZED") {
    return { ok: true, statementId: stmt.id }; // idempotent
  }

  // Gate check.
  const pendingLines = await prisma.fluxLine.findMany({
    where: { statementId: stmt.id, status: "NEEDS_COMMENT" },
    select: {
      id: true,
      account: { select: { code: true, name: true } },
    },
  });
  if (pendingLines.length > 0) {
    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      action: "flux.statement.finalize.refused",
      resource: "FluxStatement",
      resourceId: stmt.id,
      tenantId: tenant.id,
      metadata: {
        reason: "lines-need-comment",
        pendingCount: pendingLines.length,
      },
    });
    return {
      ok: false,
      code: "FINALIZE_GATE_BLOCKED",
      error: `Cannot finalize: ${pendingLines.length} material line${pendingLines.length === 1 ? "" : "s"} still need commentary`,
      pendingLines: pendingLines.map((l) => ({
        id: l.id,
        accountCode: l.account.code,
        accountName: l.account.name,
      })),
    };
  }

  await prisma.fluxStatement.update({
    where: { id: stmt.id },
    data: {
      status: "FINALIZED",
      finalizedBy: user.id,
      finalizedAt: new Date(),
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "flux.statement.finalize",
    resource: "FluxStatement",
    resourceId: stmt.id,
    tenantId: tenant.id,
  });
  revalidatePath(`/close/flux`);
  revalidatePath(`/close/flux/${stmt.id}`);
  return { ok: true, statementId: stmt.id };
}
