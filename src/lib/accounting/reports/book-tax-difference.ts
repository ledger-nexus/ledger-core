// Book-Tax Difference report (ASC 740 / M-1 / M-3 inputs).
//
// Per the spec: "Book-tax differences are a REPORT that diffs two books
// and classifies deltas as permanent vs. temporary. Not a separate book."
//
// The classification (permanent / temporary) is informational only here;
// real ASC 740 tooling needs human judgment for "permanent" calls. v0.3
// surfaces the deltas + a heuristic classification that's correct for the
// common cases (depreciation = temporary, meals/entertainment = permanent,
// etc.) and explicitly marks ambiguous ones as UNCLASSIFIED.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { getIncomeStatement, getBalanceSheet } from "../reports";

export type BtdClassification = "PERMANENT" | "TEMPORARY" | "UNCLASSIFIED";

export interface BtdRow {
  accountCode: string;
  accountName: string;
  type: "REVENUE" | "EXPENSE" | "ASSET" | "LIABILITY" | "EQUITY";
  bookAmount: Decimal;   // value in fromBook
  taxAmount: Decimal;    // value in toBook
  delta: Decimal;        // bookAmount - taxAmount (positive = book > tax)
  classification: BtdClassification;
  rationale: string;
}

export interface BookTaxDifferenceReport {
  entityCode: string;
  fromBookCode: string;
  toBookCode: string;
  periodStart: Date;
  periodEnd: Date;

  bookNetIncome: Decimal;
  taxNetIncome: Decimal;
  totalDelta: Decimal;
  permanentDeltaTotal: Decimal;
  temporaryDeltaTotal: Decimal;
  unclassifiedDeltaTotal: Decimal;

  pnlRows: BtdRow[];
  balanceSheetRows: BtdRow[];
}

// Heuristic classification by account subtype / code. The defaults match
// typical SaaS company patterns; an org can override via the
// CustomFieldDefinition "tax_sensitivity" attribute on accounts (left
// as a v0.4 enhancement).
function classify(
  accountSubtype: string | null,
  accountCode: string,
  type: "REVENUE" | "EXPENSE" | "ASSET" | "LIABILITY" | "EQUITY"
): { classification: BtdClassification; rationale: string } {
  // Depreciation / fixed-asset basis differences → TEMPORARY (almost
  // universally true; tax catches up with GAAP over the asset's life).
  if (accountSubtype === "ACCUM_DEPR" || accountCode === "1510") {
    return { classification: "TEMPORARY", rationale: "Depreciation method/life difference" };
  }
  if (accountCode === "8000" || accountSubtype === "DEPRECIATION") {
    return { classification: "TEMPORARY", rationale: "Depreciation expense divergence" };
  }
  // Deferred revenue → TEMPORARY (timing).
  if (accountSubtype === "DEFERRED_REV" || accountCode === "2200") {
    return { classification: "TEMPORARY", rationale: "Revenue recognition timing" };
  }
  // Lease ROU asset / liability → TEMPORARY (capitalized vs cash basis).
  if (accountCode.startsWith("16") || accountCode.startsWith("26")) {
    return { classification: "TEMPORARY", rationale: "Lease capitalization (ASC 842) vs cash-basis tax" };
  }
  // Most P&L / BS accounts: unclassified — analyst must annotate.
  return { classification: "UNCLASSIFIED", rationale: "Defaults — review for permanent vs temporary" };
}

export async function getBookTaxDifference(
  prisma: PrismaClient,
  input: {
    entityCode: string;
    fromBookCode: string; // e.g. "US_GAAP"
    toBookCode: string;   // e.g. "US_TAX"
    periodStart: Date;
    periodEnd: Date;
    /**
     * Tenant the entity must belong to. UI/API callers MUST pass this
     * (from getCurrentScope) — entity codes are only unique per tenant.
     * Omitting it falls back to the legacy global entity lookup
     * (substrate seeds + single-tenant scripts).
     */
    tenantId?: string;
  }
): Promise<BookTaxDifferenceReport> {
  // Resolve the entity FIRST so the subtype scan below can pin to its
  // tenant — the permanent/temporary heuristic keys off subtype, and a
  // same-code account in another tenant must not drive the call.
  const entity = await prisma.legalEntity.findFirst({
    where: input.tenantId
      ? { tenantId: input.tenantId, code: input.entityCode }
      : { code: input.entityCode },
    select: { id: true, tenantId: true },
  });
  if (!entity) throw new Error(`Unknown entity: ${input.entityCode}`);

  const [bookPnl, taxPnl, bookBs, taxBs] = await Promise.all([
    getIncomeStatement(
      prisma,
      { entityCode: input.entityCode, bookCode: input.fromBookCode, tenantId: input.tenantId },
      input.periodStart,
      input.periodEnd
    ),
    getIncomeStatement(
      prisma,
      { entityCode: input.entityCode, bookCode: input.toBookCode, tenantId: input.tenantId },
      input.periodStart,
      input.periodEnd
    ),
    getBalanceSheet(
      prisma,
      { entityCode: input.entityCode, bookCode: input.fromBookCode, tenantId: input.tenantId },
      input.periodEnd
    ),
    getBalanceSheet(
      prisma,
      { entityCode: input.entityCode, bookCode: input.toBookCode, tenantId: input.tenantId },
      input.periodEnd
    ),
  ]);

  // Build a map of account → (bookAmount, taxAmount) for P&L accounts.
  // Pull subtypes for classification.
  //
  // tenantId pin: this used to scan the ENTIRE account table — every
  // tenant's chart. The map is last-write-wins by code, so another
  // tenant's same-code account could flip a delta's permanent/temporary
  // classification. Codes are only unique per tenant; scan ours only.
  const accountSubtypeMap = new Map<string, string | null>();
  const accounts = await prisma.account.findMany({
    where: {
      tenantId: entity.tenantId,
      OR: [{ entityId: null }, { entityId: entity.id }],
    },
    select: { code: true, subtype: true },
  });
  for (const a of accounts) accountSubtypeMap.set(a.code, a.subtype);

  function diff(
    bookAccts: { code: string; name: string; amount: Decimal }[],
    taxAccts: { code: string; name: string; amount: Decimal }[],
    type: "REVENUE" | "EXPENSE" | "ASSET" | "LIABILITY" | "EQUITY"
  ): BtdRow[] {
    const byCode = new Map<string, { name: string; bookAmount: Decimal; taxAmount: Decimal }>();
    for (const a of bookAccts) {
      byCode.set(a.code, { name: a.name, bookAmount: a.amount, taxAmount: new Decimal(0) });
    }
    for (const a of taxAccts) {
      const existing = byCode.get(a.code);
      if (existing) existing.taxAmount = a.amount;
      else byCode.set(a.code, { name: a.name, bookAmount: new Decimal(0), taxAmount: a.amount });
    }
    return Array.from(byCode.entries())
      .map(([code, v]) => {
        const delta = v.bookAmount.minus(v.taxAmount);
        const { classification, rationale } = classify(
          accountSubtypeMap.get(code) ?? null,
          code,
          type
        );
        return {
          accountCode: code,
          accountName: v.name,
          type,
          bookAmount: v.bookAmount,
          taxAmount: v.taxAmount,
          delta,
          classification,
          rationale,
        };
      })
      .filter((r) => !r.delta.isZero())
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }

  const pnlRows = [
    ...diff(bookPnl.revenue, taxPnl.revenue, "REVENUE"),
    ...diff(bookPnl.expenses, taxPnl.expenses, "EXPENSE"),
  ];
  const balanceSheetRows = [
    ...diff(bookBs.assets, taxBs.assets, "ASSET"),
    ...diff(bookBs.liabilities, taxBs.liabilities, "LIABILITY"),
    ...diff(bookBs.equity, taxBs.equity, "EQUITY"),
  ];

  const totalDelta = bookPnl.netIncome.minus(taxPnl.netIncome);

  function sumWhere(rows: BtdRow[], cls: BtdClassification): Decimal {
    return rows
      .filter((r) => r.classification === cls)
      .reduce((acc, r) => acc.plus(r.delta), new Decimal(0));
  }

  return {
    entityCode: input.entityCode,
    fromBookCode: input.fromBookCode,
    toBookCode: input.toBookCode,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    bookNetIncome: bookPnl.netIncome,
    taxNetIncome: taxPnl.netIncome,
    totalDelta,
    permanentDeltaTotal: sumWhere(pnlRows, "PERMANENT"),
    temporaryDeltaTotal: sumWhere(pnlRows, "TEMPORARY"),
    unclassifiedDeltaTotal: sumWhere(pnlRows, "UNCLASSIFIED"),
    pnlRows,
    balanceSheetRows,
  };
}
