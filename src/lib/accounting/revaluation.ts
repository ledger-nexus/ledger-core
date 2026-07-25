// Period-end multi-currency revaluation (ASC 830 / IAS 21 monetary-item
// remeasurement).
//
// `computeRevaluation` is a PURE read — it computes the unrealized FX
// gain/loss on a (entity, book, period)'s foreign-currency monetary
// balances at the period-end CLOSE rate. It writes nothing. PR 3 wires
// the result into postJournalEntry (with a reversing entry next period).
//
// ── What gets revalued ───────────────────────────────────────────────
// Every account flagged isMonetary (PR 1) that holds a balance in a
// currency other than the book's reporting currency. Cash, intercompany
// due-from/due-to, and the AR/AP control accounts all qualify.
//
// ── The carrying basis (why GL, not the open items) ──────────────────
// The gain/loss MATH is sourced from the GL line amounts for every
// account, AR/AP included:
//
//   foreignBalance  = Σ transactionAmount   (signed, debit − credit, in the foreign ccy)
//   carrying        = Σ reportingAmount      (signed, in the book's reporting ccy)
//   revalued        = foreignBalance × closeRate(foreignCcy → reportingCcy, period.endsOn)
//   unrealized G/L  = revalued − carrying    (rounded to reporting-ccy decimals)
//
// Working in signed (debit − credit) space means the AR (debit-normal)
// and AP (credit-normal) signs fall out automatically — a strengthening
// foreign currency is a gain on a receivable and a loss on a payable,
// and the signed arithmetic produces exactly that without special-casing.
//
// AR/AP rows are additionally ENRICHED with per-invoice open-item detail
// (party, reference, currentBalance) for granularity — but the total
// only ever sums each GL (account, currency) group ONCE, so there is no
// double-count between the GL figure and the sub-ledger detail. The
// open-item foreign total is surfaced beside the GL foreign balance so
// any sub-ledger-to-GL drift is visible to the reviewer rather than
// silently absorbed. We do NOT revalue open items independently: they
// store only a foreign currentBalance with no per-item booking rate, so
// the GL net (which captures partial payments at intermediate rates) is
// the only correct carrying basis.
//
// SOC 2: CC6.1 every read tenant + (entity, book) scoped. Pure read — no
// mutation, no audit row (the posting in PR 3 carries the audit trail).

import { PrismaClient } from "@prisma/client";
import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import { Decimal } from "decimal.js";

import { resolveFxRate } from "@/lib/accounting/fx";

// Control-account subtypes whose GL rows we enrich with open-item detail.
const AR_SUBTYPE = "AR_TRADE";
const AP_SUBTYPE = "AP_TRADE";

export interface RevaluationScope {
  entityCode: string;
  bookCode?: string; // default "US_GAAP"
  tenantId?: string;
  /** Period to revalue, e.g. "2026-06". CLOSE rate is taken at period.endsOn. */
  periodCode: string;
}

export interface RevaluationOpenItemDetail {
  partyCode: string;
  partyName: string;
  referenceNumber: string | null;
  /** Unsigned remaining balance in the foreign currency. */
  currentBalance: Decimal;
}

export type RevaluationSource = "GL" | "AR_SUBLEDGER" | "AP_SUBLEDGER";

export interface RevaluationLine {
  source: RevaluationSource;
  accountCode: string;
  accountName: string;
  /** The foreign transaction currency being remeasured. */
  currency: string;
  /** Signed (debit − credit) balance in the foreign currency. */
  foreignBalance: Decimal;
  /** Signed carrying value in the book's reporting currency (current GL basis). */
  carryingReportingBalance: Decimal;
  closeRate: Decimal;
  closeRateEffectiveDate: Date;
  closeRateInverted: boolean;
  /** foreignBalance × closeRate, signed, in reporting currency. */
  revaluedReportingBalance: Decimal;
  /** revalued − carrying, rounded to reporting-ccy decimals. + = gain, − = loss. */
  unrealizedGainLoss: Decimal;
  /** AR/AP only: per-invoice breakdown for transparency (not part of the math). */
  openItems?: RevaluationOpenItemDetail[];
  /**
   * AR/AP only: Σ open-item currentBalance in the foreign currency.
   * Should reconcile to |foreignBalance|; a divergence flags sub-ledger
   * drift the reviewer should investigate before posting.
   */
  openItemForeignTotal?: Decimal;
}

export interface RevaluationResult {
  scope: { entityCode: string; bookCode: string; periodCode: string };
  asOf: Date;
  reportingCurrency: string;
  functionalCurrency: string;
  lines: RevaluationLine[];
  /** Signed sum of every line's unrealizedGainLoss. + = net gain, − = net loss. */
  totalUnrealizedGainLoss: Decimal;
}

export class RevaluationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevaluationScopeError";
  }
}

const DEFAULT_BOOK = "US_GAAP";

/**
 * Compute the unrealized FX gain/loss for a (entity, book, period)'s
 * foreign-currency monetary balances at the period-end CLOSE rate.
 * Pure read — writes nothing.
 */
export async function computeRevaluation(
  prisma: PrismaClient,
  scope: RevaluationScope
): Promise<RevaluationResult> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;

  const entity = await prisma.legalEntity.findFirst({
    where: {
      code: scope.entityCode,
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    },
    select: { id: true, functionalCurrencyId: true },
  });
  if (!entity) {
    throw new RevaluationScopeError(`Unknown entity: ${scope.entityCode}`);
  }

  const book = await prisma.book.findUnique({
    where: { code: bookCode },
    select: { id: true, reportingCurrencyId: true },
  });
  if (!book) {
    throw new RevaluationScopeError(`Unknown book: ${bookCode}`);
  }

  // Period → asOf date (period end). Scoped to the entity's calendar.
  const period = await prisma.period.findFirst({
    where: {
      code: scope.periodCode,
      calendar: { entityId: entity.id },
    },
    select: { id: true, endsOn: true },
  });
  if (!period) {
    throw new RevaluationScopeError(
      `Unknown period ${scope.periodCode} for entity ${scope.entityCode}`
    );
  }
  const asOf = period.endsOn;

  const reportingCurrency = book.reportingCurrencyId;

  // Reporting-currency decimals for rounding the gain/loss.
  const reportingCcy = await prisma.currency.findUnique({
    where: { code: reportingCurrency },
    select: { decimals: true },
  });
  const reportingDecimals = reportingCcy?.decimals ?? 2;

  // Monetary accounts in scope (shared chart entityId=null OR this entity).
  const monetaryAccounts = await prisma.account.findMany({
    where: {
      active: true,
      isMonetary: true,
      OR: [{ entityId: null }, { entityId: entity.id }],
    },
    select: { id: true, code: true, name: true, subtype: true },
  });
  if (monetaryAccounts.length === 0) {
    return emptyResult(scope, bookCode, asOf, reportingCurrency, entity.functionalCurrencyId);
  }

  // Pull the foreign-currency lines for those accounts in one query:
  // (entity, book, documentDate <= asOf), transaction currency != the
  // book's reporting currency. Group in memory by (account, currency).
  const accountIds = monetaryAccounts.map((a) => a.id);
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: { in: accountIds },
      transactionCurrencyId: { not: reportingCurrency },
      entry: { entityId: entity.id, bookId: book.id, documentDate: { lte: asOf }, status: { in: [...LEDGER_EFFECTIVE_STATUSES] } },
    },
    select: {
      accountId: true,
      transactionCurrencyId: true,
      transactionAmount: true,
      reportingAmount: true,
    },
  });

  // Accumulate signed foreign + carrying per (accountId, currency).
  interface Group {
    accountId: string;
    currency: string;
    foreign: Decimal;
    carrying: Decimal;
  }
  const groups = new Map<string, Group>();
  for (const l of lines) {
    const ccy = l.transactionCurrencyId ?? reportingCurrency;
    const key = `${l.accountId}::${ccy}`;
    const g =
      groups.get(key) ??
      { accountId: l.accountId, currency: ccy, foreign: new Decimal(0), carrying: new Decimal(0) };
    g.foreign = g.foreign.plus(new Decimal(l.transactionAmount.toString()));
    g.carrying = g.carrying.plus(new Decimal(l.reportingAmount.toString()));
    groups.set(key, g);
  }

  const acctById = new Map(monetaryAccounts.map((a) => [a.id, a]));
  const resultLines: RevaluationLine[] = [];
  let total = new Decimal(0);

  for (const g of groups.values()) {
    // Skip groups that net to a zero foreign balance — nothing to revalue.
    if (g.foreign.isZero() && g.carrying.isZero()) continue;

    const acct = acctById.get(g.accountId)!;
    const resolved = await resolveFxRate(prisma, {
      fromCurrency: g.currency,
      toCurrency: reportingCurrency,
      asOf,
      rateType: "CLOSE",
    });
    const revalued = g.foreign.times(resolved.rate);
    const gainLoss = revalued
      .minus(g.carrying)
      .toDecimalPlaces(reportingDecimals, Decimal.ROUND_HALF_EVEN);

    const source: RevaluationSource =
      acct.subtype === AR_SUBTYPE
        ? "AR_SUBLEDGER"
        : acct.subtype === AP_SUBTYPE
          ? "AP_SUBLEDGER"
          : "GL";

    const line: RevaluationLine = {
      source,
      accountCode: acct.code,
      accountName: acct.name,
      currency: g.currency,
      foreignBalance: g.foreign,
      carryingReportingBalance: g.carrying,
      closeRate: resolved.rate,
      closeRateEffectiveDate: resolved.effectiveDate,
      closeRateInverted: resolved.inverted,
      revaluedReportingBalance: revalued,
      unrealizedGainLoss: gainLoss,
    };

    // Enrich AR/AP rows with open-item detail (transparency, not math).
    if (source === "AR_SUBLEDGER" || source === "AP_SUBLEDGER") {
      const detail = await openItemDetail(
        prisma,
        source === "AR_SUBLEDGER" ? "AR" : "AP",
        entity.id,
        book.id,
        g.currency
      );
      line.openItems = detail.items;
      line.openItemForeignTotal = detail.foreignTotal;
    }

    resultLines.push(line);
    total = total.plus(gainLoss);
  }

  // Stable ordering: account code, then currency.
  resultLines.sort(
    (a, b) =>
      a.accountCode.localeCompare(b.accountCode) ||
      a.currency.localeCompare(b.currency)
  );

  return {
    scope: { entityCode: scope.entityCode, bookCode, periodCode: scope.periodCode },
    asOf,
    reportingCurrency,
    functionalCurrency: entity.functionalCurrencyId,
    lines: resultLines,
    totalUnrealizedGainLoss: total,
  };
}

const OPEN_STATUSES = ["OPEN", "PARTIAL", "REOPENED"] as const;

// One detail fetcher for both sub-ledgers — the AR/AP open-item tables
// are deliberate mirrors, so a single status-filter change covers both.
async function openItemDetail(
  prisma: PrismaClient,
  kind: "AR" | "AP",
  entityId: string,
  bookId: string,
  currency: string
): Promise<{ items: RevaluationOpenItemDetail[]; foreignTotal: Decimal }> {
  const rows =
    kind === "AR"
      ? await prisma.arOpenItem.findMany({
          where: {
            entityId,
            bookId,
            currencyId: currency,
            status: { in: [...OPEN_STATUSES] },
          },
          select: {
            referenceNumber: true,
            currentBalance: true,
            party: { select: { code: true, displayName: true } },
          },
        })
      : await prisma.apOpenItem.findMany({
          where: {
            entityId,
            bookId,
            currencyId: currency,
            status: { in: [...OPEN_STATUSES] },
          },
          select: {
            referenceNumber: true,
            currentBalance: true,
            party: { select: { code: true, displayName: true } },
          },
        });
  return summarizeOpenItems(rows);
}

function summarizeOpenItems(
  rows: Array<{
    referenceNumber: string | null;
    currentBalance: { toString(): string };
    party: { code: string; displayName: string };
  }>
): { items: RevaluationOpenItemDetail[]; foreignTotal: Decimal } {
  let foreignTotal = new Decimal(0);
  const items: RevaluationOpenItemDetail[] = rows.map((r) => {
    const bal = new Decimal(r.currentBalance.toString());
    foreignTotal = foreignTotal.plus(bal);
    return {
      partyCode: r.party.code,
      partyName: r.party.displayName,
      referenceNumber: r.referenceNumber,
      currentBalance: bal,
    };
  });
  return { items, foreignTotal };
}

function emptyResult(
  scope: RevaluationScope,
  bookCode: string,
  asOf: Date,
  reportingCurrency: string,
  functionalCurrency: string
): RevaluationResult {
  return {
    scope: { entityCode: scope.entityCode, bookCode, periodCode: scope.periodCode },
    asOf,
    reportingCurrency,
    functionalCurrency,
    lines: [],
    totalUnrealizedGainLoss: new Decimal(0),
  };
}
