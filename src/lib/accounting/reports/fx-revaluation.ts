// Period-end FX revaluation cycle.
//
// At month-end, foreign-currency-denominated balance-sheet accounts
// (typically AR / AP / foreign-currency cash) need their reporting
// values adjusted to the current FX rate. The difference between the
// CARRYING reporting value (sum of historical conversions when
// transactions hit) and the REVALUED reporting value (sum of foreign-
// currency balances × current CLOSE rate) is recognized as an
// unrealized FX gain or loss.
//
// This module:
//
//   1. Computes per-account, per-foreign-currency carrying balances
//      (debits − credits) in BOTH the transaction currency AND the
//      reporting currency, for one (entity, book).
//
//   2. Looks up the CLOSE FxRate from transaction → reporting for
//      each foreign-currency balance as of the asOfDate.
//
//   3. Computes the revaluation delta per account:
//        revalued reporting = txAmount × FX rate
//        delta              = revalued − carrying reporting
//      A non-zero delta means the carrying value is stale.
//
//   4. Builds a single JE that DR/CR each account by |delta| with
//      the side determined by account.normalBalance and sign(delta),
//      plus a balancing line on Unrealized FX Gain (Cr) or Loss (Dr).
//
//   5. Returns either a dry-run preview (no DB writes) or the posted
//      entry number when given posting params.
//
// Scope (v1):
//   - ACCOUNT-LEVEL aggregation. Each account's net foreign-currency
//     balance is revalued as a group. Real-world AR/AP often does
//     LINE-LEVEL (each invoice settles at its own historical rate),
//     which preserves the gain/loss split between invoices that
//     strengthened and weakened. Future work.
//   - Posts ONE JE summarizing all per-account adjustments + one net
//     FX gain/loss line. Two-decimal rounding lands on the FX line.
//   - Reads the CLOSE rate type. Callers needing AVG (e.g. P&L
//     translation for consolidation) compose this differently.
//   - Doesn't touch FixedAssetBookAttributes or any sub-ledger
//     bookkeeping — just adjusts the GL carrying values.

import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../post-journal";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

const DEFAULT_FX_GAIN_ACCOUNT = "7300";
const DEFAULT_FX_LOSS_ACCOUNT = "7400";

export interface FxRevaluationInput {
  tenantId: string;
  entityCode: string;
  bookCode: string;
  /** Last day of the period being revalued. */
  asOfDate: Date;
  /** Override the default 7300 unrealized FX gain account. */
  fxGainAccountCode?: string;
  /** Override the default 7400 unrealized FX loss account. */
  fxLossAccountCode?: string;
  /** Caller identity for audit. */
  createdBy?: string;
}

export interface FxAccountAdjustment {
  accountCode: string;
  accountName: string;
  normalBalance: "DEBIT" | "CREDIT";
  transactionCurrencyId: string;
  /** Net foreign-currency balance on the books. */
  transactionCarrying: Decimal;
  /** Net carrying value in the reporting currency (historical conversions). */
  reportingCarrying: Decimal;
  /** Revalued reporting value = transactionCarrying × closeRate. */
  reportingRevalued: Decimal;
  /** revalued − carrying. Positive = need to increase the carrying value. */
  delta: Decimal;
  closeRate: Decimal;
}

export interface FxRevaluationPreview {
  asOfDate: Date;
  reportingCurrencyId: string;
  adjustments: FxAccountAdjustment[];
  /** Net unrealized FX gain (positive) or loss (negative). */
  netGainLoss: Decimal;
  /** Missing CLOSE rates (foreign currency codes with no rate at asOfDate). */
  missingRates: string[];
}

/**
 * Compute the FX revaluation WITHOUT posting. Returns the per-account
 * adjustments + net gain/loss. The UI uses this for the "preview"
 * step before committing.
 *
 * Missing rates (transaction currencies without a CLOSE rate at the
 * asOfDate) are returned separately so the UI can surface them. The
 * caller decides whether to refuse / continue with partial coverage.
 */
export async function previewFxRevaluation(
  prisma: PrismaClient,
  input: FxRevaluationInput
): Promise<FxRevaluationPreview> {
  // 1. Resolve book + entity, get reporting currency.
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: input.bookCode },
    select: { id: true, reportingCurrencyId: true },
  });
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: input.entityCode, tenantId: input.tenantId },
    select: { id: true },
  });
  const reportingCurrency = book.reportingCurrencyId;

  // 2. Sum debits and credits per (account, transactionCurrencyId)
  //    for this (entity, book) through the asOfDate. Filtered to
  //    POSTED entries only — pending/draft/void don't count.
  //    Foreign-currency only: transactionCurrencyId != reportingCurrency.
  type RawRow = {
    accountId: string;
    transactionCurrencyId: string;
    txDr: string | null;
    txCr: string | null;
    rptDr: string | null;
    rptCr: string | null;
  };

  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT
      l.account_id::text                                AS "accountId",
      l.transaction_currency_id                         AS "transactionCurrencyId",
      SUM(CASE WHEN l.debit > 0 THEN l.transaction_amount ELSE 0 END)::text  AS "txDr",
      SUM(CASE WHEN l.credit > 0 THEN l.transaction_amount ELSE 0 END)::text AS "txCr",
      SUM(l.debit)::text                                 AS "rptDr",
      SUM(l.credit)::text                                AS "rptCr"
    FROM gl_entry_line l
    JOIN gl_entry_header h ON l.entry_id = h.id
    WHERE h.entity_id = ${entity.id}::uuid
      AND h.book_id   = ${book.id}::uuid
      AND h.tenant_id = ${input.tenantId}::uuid
      AND h.status    = 'POSTED'
      AND h.document_date <= ${input.asOfDate}::date
      AND l.transaction_currency_id <> ${reportingCurrency}
    GROUP BY l.account_id, l.transaction_currency_id
    HAVING SUM(l.debit) <> SUM(l.credit) OR SUM(CASE WHEN l.debit > 0 THEN l.transaction_amount ELSE 0 END) <> SUM(CASE WHEN l.credit > 0 THEN l.transaction_amount ELSE 0 END)
  `;

  // 3. Resolve accountCode + normalBalance + name for each accountId.
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const accounts = accountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: accountIds }, tenantId: input.tenantId },
        select: { id: true, code: true, name: true, normalBalance: true, type: true },
      })
    : [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // 4. Fetch CLOSE rates for each foreign currency present.
  const currencies = [...new Set(rows.map((r) => r.transactionCurrencyId))];
  const rates = currencies.length
    ? await prisma.fxRate.findMany({
        where: {
          fromCurrencyId: { in: currencies },
          toCurrencyId: reportingCurrency,
          asOf: { lte: input.asOfDate },
          rateType: "CLOSE",
        },
        orderBy: [{ fromCurrencyId: "asc" }, { asOf: "desc" }],
      })
    : [];
  // Pick the latest rate ≤ asOfDate per currency.
  const closeRateByCurrency = new Map<string, Decimal>();
  for (const r of rates) {
    if (!closeRateByCurrency.has(r.fromCurrencyId)) {
      closeRateByCurrency.set(
        r.fromCurrencyId,
        new Decimal(r.rate.toString())
      );
    }
  }

  // 5. Build adjustments.
  const adjustments: FxAccountAdjustment[] = [];
  const missingRates = new Set<string>();
  for (const r of rows) {
    const account = accountById.get(r.accountId);
    if (!account) continue; // shouldn't happen — defensive

    // We only revalue balance-sheet accounts (ASSET, LIABILITY, EQUITY).
    // P&L accounts (REVENUE, EXPENSE) translate at AVG rate during
    // consolidation, not via this period-close revaluation cycle.
    if (account.type !== "ASSET" && account.type !== "LIABILITY" && account.type !== "EQUITY") {
      continue;
    }

    const rate = closeRateByCurrency.get(r.transactionCurrencyId);
    if (!rate) {
      missingRates.add(r.transactionCurrencyId);
      continue;
    }

    // Compute net carrying balances (signed).
    const txDr = new Decimal(r.txDr ?? "0");
    const txCr = new Decimal(r.txCr ?? "0");
    const transactionCarrying =
      account.normalBalance === "DEBIT" ? txDr.minus(txCr) : txCr.minus(txDr);

    const rptDr = new Decimal(r.rptDr ?? "0");
    const rptCr = new Decimal(r.rptCr ?? "0");
    const reportingCarrying =
      account.normalBalance === "DEBIT" ? rptDr.minus(rptCr) : rptCr.minus(rptDr);

    // Revalued reporting = signed foreign balance × rate (rate is
    // always positive in our schema; sign comes from carrying).
    const reportingRevalued = transactionCarrying
      .times(rate)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

    const delta = reportingRevalued.minus(reportingCarrying);

    // Skip zero-delta accounts — no adjustment to post.
    if (delta.equals(0)) continue;

    adjustments.push({
      accountCode: account.code,
      accountName: account.name,
      normalBalance: account.normalBalance as "DEBIT" | "CREDIT",
      transactionCurrencyId: r.transactionCurrencyId,
      transactionCarrying,
      reportingCarrying,
      reportingRevalued,
      delta,
      closeRate: rate,
    });
  }

  // 6. Net gain/loss = sum of deltas across all accounts.
  //
  // Why sum of deltas (not separate gain/loss totals): each adjustment
  // is a signed reporting-value change. The opposite leg of the JE is
  // a P&L recognition; positive net = unrealized gain (CR side),
  // negative net = loss (DR side). The math is symmetric.
  //
  // Strictly: an ASSET account's positive delta (carrying went up) is
  // a gain. A LIABILITY account's positive delta (liability got bigger)
  // is a loss. But by walking with normalBalance signing above, our
  // "delta" is already in P&L-direction terms — sum directly.
  const netGainLoss = adjustments.reduce(
    (acc, a) =>
      a.normalBalance === "DEBIT"
        ? acc.plus(a.delta)
        : acc.minus(a.delta),
    new Decimal(0)
  );

  return {
    asOfDate: input.asOfDate,
    reportingCurrencyId: reportingCurrency,
    adjustments,
    netGainLoss,
    missingRates: [...missingRates].sort(),
  };
}

export interface FxRevaluationPostResult {
  preview: FxRevaluationPreview;
  /** null if no adjustments needed (everything already revalued). */
  entryNumber: string | null;
}

/**
 * Compute and POST the FX revaluation JE. Returns the preview + the
 * posted entry number (or null when there's nothing to adjust).
 */
export async function postFxRevaluation(
  prisma: PrismaClient,
  input: FxRevaluationInput
): Promise<FxRevaluationPostResult> {
  const preview = await previewFxRevaluation(prisma, input);

  if (preview.adjustments.length === 0) {
    return { preview, entryNumber: null };
  }

  // Build the JE lines from the preview adjustments.
  //
  // For each adjustment: the account side is determined by
  //   (account.normalBalance, sign(delta)). Working in P&L-direction
  //   terms: positive delta on a DEBIT-normal account means we need
  //   to DR the account (carrying value goes up = asset got more
  //   valuable). Positive delta on a CREDIT-normal account means we
  //   need to CR the account (liability got bigger = unfavorable to
  //   us = a loss). The balancing P&L line goes to either the gain or
  //   loss account based on the NET sign.
  const fxGainAccount =
    input.fxGainAccountCode ?? DEFAULT_FX_GAIN_ACCOUNT;
  const fxLossAccount =
    input.fxLossAccountCode ?? DEFAULT_FX_LOSS_ACCOUNT;

  const lines: Array<{
    accountCode: string;
    debit?: string;
    credit?: string;
    description: string;
  }> = [];

  for (const a of preview.adjustments) {
    const absAmount = a.delta.abs().toFixed(4);
    const positiveDelta = a.delta.greaterThan(0);
    const debitSide =
      (a.normalBalance === "DEBIT" && positiveDelta) ||
      (a.normalBalance === "CREDIT" && !positiveDelta);
    lines.push({
      accountCode: a.accountCode,
      ...(debitSide ? { debit: absAmount } : { credit: absAmount }),
      description: `FX reval ${a.accountCode} ${a.transactionCurrencyId} → ${preview.reportingCurrencyId} @ ${a.closeRate.toFixed(6)}`,
    });
  }

  // Balancing P&L line.
  const netAbs = preview.netGainLoss.abs().toFixed(4);
  if (preview.netGainLoss.greaterThan(0)) {
    lines.push({
      accountCode: fxGainAccount,
      credit: netAbs,
      description: `Unrealized FX gain — period end ${input.asOfDate.toISOString().slice(0, 10)}`,
    });
  } else if (preview.netGainLoss.lessThan(0)) {
    lines.push({
      accountCode: fxLossAccount,
      debit: netAbs,
      description: `Unrealized FX loss — period end ${input.asOfDate.toISOString().slice(0, 10)}`,
    });
  } else {
    // netGainLoss is exactly zero but individual deltas weren't. This
    // can happen if gains on some accounts exactly offset losses on
    // others. The JE is still valid (all per-account adjustments
    // sum to zero net P&L), but postJournalEntry will refuse the
    // unbalanced state if Σdebits != Σcredits. The natural-offset
    // case actually balances by construction. Skip the P&L line.
  }

  const posted = await postJournalEntry(prisma, {
    tenantId: input.tenantId,
    entityCode: input.entityCode,
    bookCode: input.bookCode,
    currencyCode: preview.reportingCurrencyId,
    documentDate: input.asOfDate,
    memo: `FX revaluation — ${input.asOfDate.toISOString().slice(0, 10)} (${preview.adjustments.length} accounts)`,
    source: "SYSTEM",
    sourceRecordType: "FxRevaluation",
    sourceRecordId: `${input.entityCode}:${input.bookCode}:${input.asOfDate.toISOString().slice(0, 10)}`,
    createdBy: input.createdBy,
    extensions: {
      adjustmentCount: preview.adjustments.length,
      netGainLoss: preview.netGainLoss.toFixed(2),
      missingRates: preview.missingRates,
    },
    lines,
  });

  return { preview, entryNumber: posted.entryNumber };
}
