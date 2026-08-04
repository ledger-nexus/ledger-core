// Post a period-end FX revaluation (ASC 830 / IAS 21).
//
// Wraps the pure computeRevaluation engine (PR 2) with the write path:
//   1. Compute the unrealized gain/loss per foreign-currency monetary
//      balance at the period-end CLOSE rate.
//   2. Post ONE balanced adjustment JE in the book's reporting currency:
//      a line per monetary account moving its carrying value by the
//      gain/loss, offset to the Unrealized FX Gain/Loss account (8300).
//   3. Post a REVERSING entry dated the first day of the next period,
//      linked via reversalOfId. Unrealized FX adjustments reverse next
//      period so each period revalues against the original historical
//      basis — without the reversal the GL would compound stale FX
//      layers (computeRevaluation excludes the reporting-currency
//      adjustment lines from the carrying sum, so the reversal is what
//      keeps the GL itself clean).
//
// Both posts run in one $transaction — all-or-nothing. If the next
// period is closed, postJournalEntry rejects the reversal and the whole
// thing rolls back (you can't book a reversal into a closed period).
//
// Idempotency: probed on the lineage triple
//   (sourceSystem="FX_REVAL", sourceRecordType="MonetaryRevaluation",
//    sourceRecordId="<entityCode>-<bookCode>-<periodCode>")
// A repeat call finds the existing adjustment and returns it as a
// no-op (wasDuplicate), never double-posting.
//
// AI/human boundary (CLAUDE.md): the adjustment posts with
// source="AI_APPROVED" — the rate + gain/loss are machine-computed, so
// this function MUST be invoked behind a human-confirmed action (the
// PR 4 Server Action). It is not wired to any auto-fire path.
//
// SOC 2: CC6.1 tenant + (entity, book) scoped. CC7.2 a PRIVILEGED_ACTION
// audit row per post + the JE rows themselves are the granular trail.

import { PrismaClient, Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { logAuditEvent } from "@/lib/audit/log";
import {
  computeRevaluation,
  RevaluationScopeError,
  type RevaluationScope,
  type RevaluationResult,
} from "@/lib/accounting/revaluation";

const FX_GAIN_LOSS_SUBTYPE = "FX_GAIN_LOSS_UNREALIZED";
const LINEAGE_SYSTEM = "FX_REVAL";
const LINEAGE_TYPE = "MonetaryRevaluation";
const LINEAGE_TYPE_REVERSAL = "MonetaryRevaluation.reversal";
const DEFAULT_BOOK = "US_GAAP";

export interface PostRevaluationOptions {
  /**
   * Reversal entry document date. Defaults to the day after the period
   * ends (= first day of the next period). The reversal lands in the
   * next open period; if that period is closed the post is rejected.
   */
  reversalDate?: Date;
  /** Audit string for the human who approved the revaluation. */
  createdBy?: string;
  /** Workflow owner for the posted entries. */
  ownerUserId?: string;
  /** Actor for the audit row (id + email). Defaults to a system sentinel. */
  actor?: { id: string | null; email: string };
}

export interface PostRevaluationResult {
  /** The computed revaluation (always returned, even on a no-op). */
  computed: RevaluationResult;
  /** True when a new adjustment JE was posted this call. */
  posted: boolean;
  /** True when an existing adjustment for this period was found (no-op). */
  wasDuplicate: boolean;
  /**
   * True when there was nothing to revalue (no non-zero gain/loss) — no
   * JE is posted (a zero entry is degenerate). Distinct from duplicate.
   */
  noop: boolean;
  adjustmentEntryId?: string;
  adjustmentEntryNumber?: string;
  reversalEntryId?: string;
  reversalEntryNumber?: string;
}

interface SignedLine {
  accountCode: string;
  /** signed reporting-currency amount: + = debit, − = credit. */
  signed: Decimal;
}

/**
 * Compute + post the period-end FX revaluation for a (entity, book,
 * period). Idempotent on the lineage triple. Posts source=AI_APPROVED;
 * call only behind a human-confirmed action.
 */
export async function postRevaluation(
  prisma: PrismaClient,
  scope: RevaluationScope,
  opts: PostRevaluationOptions = {}
): Promise<PostRevaluationResult> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;
  const computed = await computeRevaluation(prisma, scope);

  // Resolve the ids we need for posting + idempotency. computeRevaluation
  // already validated the scope, so these lookups succeed.
  const entity = await prisma.legalEntity.findFirst({
    where: {
      code: scope.entityCode,
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    },
    select: { id: true, tenantId: true, functionalCurrencyId: true },
  });
  if (!entity) throw new RevaluationScopeError(`Unknown entity: ${scope.entityCode}`);

  const period = await prisma.period.findFirst({
    where: { code: scope.periodCode, calendar: { entityId: entity.id } },
    select: { endsOn: true },
  });
  if (!period) {
    throw new RevaluationScopeError(
      `Unknown period ${scope.periodCode} for entity ${scope.entityCode}`
    );
  }

  const lineageId = `${scope.entityCode}-${bookCode}-${scope.periodCode}`;

  // Idempotency probe — never double-post a period's revaluation.
  const existing = await prisma.journalEntry.findFirst({
    where: {
      tenantId: entity.tenantId,
      sourceSystem: LINEAGE_SYSTEM,
      sourceRecordType: LINEAGE_TYPE,
      sourceRecordId: lineageId,
    },
    select: { id: true, entryNumber: true },
  });
  if (existing) {
    return {
      computed,
      posted: false,
      wasDuplicate: true,
      noop: false,
      adjustmentEntryId: existing.id,
      adjustmentEntryNumber: existing.entryNumber,
    };
  }

  // Build the signed adjustment lines (one per account with a non-zero
  // gain/loss) + the offset to the FX gain/loss account.
  const accountLines: SignedLine[] = computed.lines
    .filter((l) => !l.unrealizedGainLoss.isZero())
    .map((l) => ({ accountCode: l.accountCode, signed: l.unrealizedGainLoss }));

  if (accountLines.length === 0) {
    // Nothing moved — don't post a zero entry.
    return { computed, posted: false, wasDuplicate: false, noop: true };
  }

  const fxAccount = await resolveFxGainLossAccount(prisma, entity.tenantId, entity.id);

  // Offset = negation of the summed account adjustments. Because each
  // gain/loss is already rounded to reporting decimals, the offset is
  // exact and the entry balances to the cent.
  const totalSigned = accountLines.reduce(
    (acc, l) => acc.plus(l.signed),
    new Decimal(0)
  );
  const offsetLine: SignedLine = { accountCode: fxAccount, signed: totalSigned.negated() };

  const reportingDecimals = await reportingCurrencyDecimals(prisma, computed.reportingCurrency);

  // Functional-currency measurement of a revaluation line:
  //   functional == reporting (the usual USD/USD case): remeasurement
  //     gain/loss on foreign-denominated monetary items is REAL
  //     functional income — let postJournalEntry derive it normally.
  //   functional ≠ reporting (foreign sub under the temporal method):
  //     the adjustment trues the REPORTING view only; in the entity's
  //     own functional currency nothing happened — stamp 0 explicitly,
  //     or current-rate translation would double-count the true-up
  //     (the #151 compounding case: 1200 × 1.30 on top of a CLOSE-rate
  //     revaluation → 1690 vs the correct 1300).
  const functionalOverride =
    entity.functionalCurrencyId === computed.reportingCurrency
      ? {}
      : { functionalAmount: 0 };

  const adjustmentLines = [...accountLines, offsetLine].map((l) => ({
    ...signedToLine(l, reportingDecimals),
    ...functionalOverride,
  }));
  // Reversal flips debit <-> credit on every line.
  const reversalLines = adjustmentLines.map((l) => ({
    accountCode: l.accountCode,
    debit: l.credit,
    credit: l.debit,
    ...functionalOverride,
  }));

  const reversalDate =
    opts.reversalDate ?? new Date(period.endsOn.getTime() + 86_400_000);

  // Post adjustment + reversal atomically.
  const { adjustment, reversal } = await prisma.$transaction(async (tx) => {
    const txc = tx as unknown as PrismaClient;
    const adjustment = await postJournalEntry(txc, {
      tenantId: entity.tenantId,
      entityCode: scope.entityCode,
      bookCode,
      currencyCode: computed.reportingCurrency, // reporting-ccy-only adjustment
      documentDate: period.endsOn,
      postingDate: period.endsOn,
      memo: `FX revaluation ${scope.periodCode} (${bookCode})`,
      source: "AI_APPROVED",
      createdBy: opts.createdBy,
      ownerUserId: opts.ownerUserId,
      sourceSystem: LINEAGE_SYSTEM,
      sourceRecordType: LINEAGE_TYPE,
      sourceRecordId: lineageId,
      lines: adjustmentLines,
    });

    const reversal = await postJournalEntry(txc, {
      tenantId: entity.tenantId,
      entityCode: scope.entityCode,
      bookCode,
      currencyCode: computed.reportingCurrency,
      documentDate: reversalDate,
      postingDate: reversalDate,
      memo: `Reversal of FX revaluation ${scope.periodCode} (${bookCode})`,
      source: "SYSTEM",
      createdBy: opts.createdBy,
      ownerUserId: opts.ownerUserId,
      sourceSystem: LINEAGE_SYSTEM,
      sourceRecordType: LINEAGE_TYPE_REVERSAL,
      sourceRecordId: lineageId,
      lines: reversalLines,
    });

    await tx.journalEntry.update({
      where: { id: reversal.id },
      data: { reversalOfId: adjustment.id },
    });

    return { adjustment, reversal };
  });

  // Audit row (best-effort, post-commit). The JE rows are the granular
  // trail; this is the privileged-action marker for access reviews.
  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "fx.revaluation.post",
    actorUserId: opts.actor?.id ?? null,
    actorEmail: opts.actor?.email ?? "system:fx-reval",
    resource: "JournalEntry",
    resourceId: adjustment.id,
    tenantId: entity.tenantId,
    metadata: {
      periodCode: scope.periodCode,
      bookCode,
      asOf: computed.asOf.toISOString().slice(0, 10),
      totalUnrealizedGainLoss: computed.totalUnrealizedGainLoss.toString(),
      lineCount: accountLines.length,
      adjustmentEntryNumber: adjustment.entryNumber,
      reversalEntryNumber: reversal.entryNumber,
      reversalDate: reversalDate.toISOString().slice(0, 10),
    },
  });

  return {
    computed,
    posted: true,
    wasDuplicate: false,
    noop: false,
    adjustmentEntryId: adjustment.id,
    adjustmentEntryNumber: adjustment.entryNumber,
    reversalEntryId: reversal.id,
    reversalEntryNumber: reversal.entryNumber,
  };
}

function signedToLine(
  l: SignedLine,
  decimals: number
): { accountCode: string; debit: string; credit: string } {
  // postJournalEntry wants non-negative debit XOR credit. We hand both
  // (one is "0.00") so the reversal flip is a clean field swap.
  if (l.signed.greaterThan(0)) {
    return { accountCode: l.accountCode, debit: l.signed.toFixed(decimals), credit: "0" };
  }
  return { accountCode: l.accountCode, debit: "0", credit: l.signed.abs().toFixed(decimals) };
}

async function resolveFxGainLossAccount(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  entityId: string
): Promise<string> {
  // Tenant-scoped (CC6.1): a shared-chart account (entityId=null) still
  // belongs to a tenant, so we must not match another tenant's 8300.
  const acct = await prisma.account.findFirst({
    where: {
      tenantId,
      subtype: FX_GAIN_LOSS_SUBTYPE,
      active: true,
      OR: [{ entityId: null }, { entityId }],
    },
    // Prefer an entity-specific override over the shared-chart account.
    orderBy: { entityId: { sort: "desc", nulls: "last" } },
    select: { code: true },
  });
  if (!acct) {
    throw new RevaluationScopeError(
      `No active account with subtype ${FX_GAIN_LOSS_SUBTYPE} (expected the seeded 8300 Unrealized FX Gain/Loss)`
    );
  }
  return acct.code;
}

async function reportingCurrencyDecimals(
  prisma: PrismaClient,
  code: string
): Promise<number> {
  const ccy = await prisma.currency.findUnique({
    where: { code },
    select: { decimals: true },
  });
  return ccy?.decimals ?? 2;
}
