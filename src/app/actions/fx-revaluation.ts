"use server";

// Server Action: post a period-end FX revaluation JE.
//
// Two entry points:
//   - previewFxRevaluationAction (read-only, for the UI preview)
//   - postFxRevaluationAction (commits the JE)
//
// Role: ADMIN+ via the policy (canClosePeriods — same role floor as
// period close, since FX revaluation is conceptually a month-end
// closing entry).

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
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
  canClosePeriods,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import {
  previewFxRevaluation,
  postFxRevaluation,
} from "@/lib/accounting/reports/fx-revaluation";
import { auditPrivilegedAction } from "@/lib/audit/log";
import {
  PeriodClosedError,
  UnknownEntityError,
  UnknownBookError,
} from "@/lib/accounting/types";

export interface FxRevaluationInputForm {
  entityCode: string;
  bookCode: string;
  /** ISO YYYY-MM-DD — last day of the period being revalued. */
  asOfDate: string;
  fxGainAccountCode?: string;
  fxLossAccountCode?: string;
}

export interface FxAdjustmentRow {
  accountCode: string;
  accountName: string;
  transactionCurrencyId: string;
  /** Decimal serialized to 4dp. */
  transactionCarrying: string;
  reportingCarrying: string;
  reportingRevalued: string;
  delta: string;
  closeRate: string;
}

export interface FxRevaluationPreviewState {
  ok: boolean;
  message?: string;
  reportingCurrencyId?: string;
  adjustments?: FxAdjustmentRow[];
  netGainLoss?: string;
  missingRates?: string[];
}

export interface FxRevaluationPostState extends FxRevaluationPreviewState {
  entryNumber?: string | null;
}

function parseAsOf(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapErrorState(e: unknown): FxRevaluationPreviewState {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  if (e instanceof PermissionDeniedError)
    return { ok: false, message: e.message };
  if (e instanceof UnknownEntityError)
    return { ok: false, message: e.message };
  if (e instanceof UnknownBookError)
    return { ok: false, message: e.message };
  if (e instanceof PeriodClosedError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: e instanceof Error ? e.message : "Unknown error during FX revaluation",
  };
}

export async function previewFxRevaluationAction(
  input: FxRevaluationInputForm
): Promise<FxRevaluationPreviewState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("fx_revaluation", tenant.role, canClosePeriods);

    if (!input.entityCode || !input.bookCode || !input.asOfDate) {
      return { ok: false, message: "entityCode, bookCode, and asOfDate are required." };
    }
    const asOf = parseAsOf(input.asOfDate);
    if (!asOf) return { ok: false, message: `Invalid asOfDate "${input.asOfDate}".` };

    const preview = await previewFxRevaluation(prisma, {
      tenantId: tenant.id,
      entityCode: input.entityCode,
      bookCode: input.bookCode,
      asOfDate: asOf,
      fxGainAccountCode: input.fxGainAccountCode,
      fxLossAccountCode: input.fxLossAccountCode,
    });

    return {
      ok: true,
      reportingCurrencyId: preview.reportingCurrencyId,
      adjustments: preview.adjustments.map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        transactionCurrencyId: a.transactionCurrencyId,
        transactionCarrying: a.transactionCarrying.toFixed(4),
        reportingCarrying: a.reportingCarrying.toFixed(4),
        reportingRevalued: a.reportingRevalued.toFixed(4),
        delta: a.delta.toFixed(4),
        closeRate: a.closeRate.toFixed(6),
      })),
      netGainLoss: preview.netGainLoss.toFixed(2),
      missingRates: preview.missingRates,
    };
  } catch (e) {
    return mapErrorState(e);
  }
}

export async function postFxRevaluationAction(
  input: FxRevaluationInputForm
): Promise<FxRevaluationPostState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("fx_revaluation", tenant.role, canClosePeriods);

    if (!input.entityCode || !input.bookCode || !input.asOfDate) {
      return { ok: false, message: "entityCode, bookCode, and asOfDate are required." };
    }
    const asOf = parseAsOf(input.asOfDate);
    if (!asOf) return { ok: false, message: `Invalid asOfDate "${input.asOfDate}".` };

    const result = await postFxRevaluation(prisma, {
      tenantId: tenant.id,
      entityCode: input.entityCode,
      bookCode: input.bookCode,
      asOfDate: asOf,
      fxGainAccountCode: input.fxGainAccountCode,
      fxLossAccountCode: input.fxLossAccountCode,
      createdBy: user.email,
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "fx.revalue",
      resource: "JournalEntry",
      resourceId: result.entryNumber ?? "(none)",
      metadata: {
        entityCode: input.entityCode,
        bookCode: input.bookCode,
        asOfDate: asOf.toISOString().slice(0, 10),
        netGainLoss: result.preview.netGainLoss.toFixed(2),
        adjustmentCount: result.preview.adjustments.length,
        entryNumber: result.entryNumber,
      },
    });

    revalidatePath("/reports/fx-revaluation");
    revalidatePath("/journal-entries");
    revalidatePath("/");

    return {
      ok: true,
      message: result.entryNumber
        ? `FX revaluation posted: ${result.entryNumber}. Net unrealized ${
            result.preview.netGainLoss.greaterThan(0) ? "gain" : "loss"
          } $${result.preview.netGainLoss.abs().toFixed(2)} across ${result.preview.adjustments.length} accounts.`
        : `No revaluation needed — every foreign balance already ties to the close rate.`,
      reportingCurrencyId: result.preview.reportingCurrencyId,
      adjustments: result.preview.adjustments.map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        transactionCurrencyId: a.transactionCurrencyId,
        transactionCarrying: a.transactionCarrying.toFixed(4),
        reportingCarrying: a.reportingCarrying.toFixed(4),
        reportingRevalued: a.reportingRevalued.toFixed(4),
        delta: a.delta.toFixed(4),
        closeRate: a.closeRate.toFixed(6),
      })),
      netGainLoss: result.preview.netGainLoss.toFixed(2),
      missingRates: result.preview.missingRates,
      entryNumber: result.entryNumber,
    };
  } catch (e) {
    return mapErrorState(e);
  }
}
