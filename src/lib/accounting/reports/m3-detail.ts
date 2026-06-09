// M-1 / M-3 detail report.
//
// Form 1120 Schedule M-3 reconciles book net income to taxable income
// with category-level detail. This report wraps getBookTaxDifference and
// re-groups the BTD rows by M-3 line so a tax preparer (or a curious
// CPA looking at a portfolio) can see "GAAP depreciation differs from
// tax by $1,600" sitting in a "Depreciation" bucket rather than as an
// anonymous account-level delta.
//
// The m3Line mapping is subtype-driven so account-code variations from
// QBO/NS imports don't break it. The list below is the common-case
// taxonomy; production engagements add lines as needed.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import {
  getBookTaxDifference,
  type BtdRow,
  type BtdClassification,
} from "./book-tax-difference";

export type M3Line =
  | "Depreciation and amortization"
  | "Bad debt expense"
  | "Lease accounting (ASC 842)"
  | "Deferred revenue / advance payments"
  | "Accrued liabilities"
  | "Inventory cost differences"
  | "Stock-based compensation"
  | "Meals and entertainment"
  | "State income tax"
  | "Charitable contributions"
  | "Other timing differences"
  | "Other permanent differences"
  | "Unclassified";

function classifyToM3Line(row: BtdRow, subtype: string | null): M3Line {
  if (subtype) {
    switch (subtype) {
      case "DEPRECIATION":
      case "ACCUM_DEPR":
      case "AMORTIZATION":
        return "Depreciation and amortization";
      case "BAD_DEBT":
      case "ALLOWANCE_DOUBTFUL":
        return "Bad debt expense";
      case "LEASE_EXPENSE":
      case "ROU_ASSET":
      case "LEASE_LIABILITY":
        return "Lease accounting (ASC 842)";
      case "DEFERRED_REV":
        return "Deferred revenue / advance payments";
      case "ACCRUED":
        return "Accrued liabilities";
      case "INVENTORY":
      case "INVENTORY_RAW":
      case "INVENTORY_WIP":
      case "INVENTORY_FINISHED":
        return "Inventory cost differences";
      case "STOCK_COMP":
        return "Stock-based compensation";
      case "MEALS":
        return "Meals and entertainment";
      case "STATE_TAX":
        return "State income tax";
      case "CHARITABLE":
        return "Charitable contributions";
    }
  }
  // Fall back via classification
  if (row.classification === "TEMPORARY") return "Other timing differences";
  if (row.classification === "PERMANENT") return "Other permanent differences";
  return "Unclassified";
}

export interface M3GroupedRow extends BtdRow {
  m3Line: M3Line;
}

export interface M3LineGroup {
  m3Line: M3Line;
  rows: M3GroupedRow[];
  totalBookAmount: Decimal;
  totalTaxAmount: Decimal;
  totalDelta: Decimal;
  classification: BtdClassification | "MIXED";
}

export interface M3DetailReport {
  entityCode: string;
  fromBookCode: string;
  toBookCode: string;
  periodStart: Date;
  periodEnd: Date;

  bookNetIncome: Decimal;
  taxNetIncome: Decimal;
  totalDelta: Decimal;

  groups: M3LineGroup[];

  // Grand totals by classification across all groups.
  permanentTotal: Decimal;
  temporaryTotal: Decimal;
  unclassifiedTotal: Decimal;
}

export async function getM3Detail(
  prisma: PrismaClient,
  input: {
    entityCode: string;
    fromBookCode: string;
    toBookCode: string;
    periodStart: Date;
    periodEnd: Date;
    tenantId?: string;
  }
): Promise<M3DetailReport> {
  const btd = await getBookTaxDifference(prisma, input);

  // Pull subtypes for each account in the diff.
  // SECURITY (SOC 2 CC6.1): tenant-scope the Account lookup. Without
  // it, accounts in OTHER tenants with the same code surface and
  // their `subtype` drives M-3 classification incorrectly. PR 7
  // closure of the gap PR 5 documented.
  const allCodes = new Set<string>([
    ...btd.pnlRows.map((r) => r.accountCode),
    ...btd.balanceSheetRows.map((r) => r.accountCode),
  ]);
  const accounts = await prisma.account.findMany({
    where: {
      code: { in: Array.from(allCodes) },
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    },
    select: { code: true, subtype: true },
  });
  const subtypeByCode = new Map(accounts.map((a) => [a.code, a.subtype]));

  // Bucket all rows (P&L + BS) by M-3 line. The IRS form mixes both —
  // M-3 reconciles book to taxable income, and BS items (timing
  // differences in deferred revenue, accum dep, etc.) drive the deferred
  // tax computation that lives alongside.
  const allRows = [...btd.pnlRows, ...btd.balanceSheetRows];
  const groupsMap = new Map<M3Line, M3GroupedRow[]>();

  for (const row of allRows) {
    const subtype = subtypeByCode.get(row.accountCode) ?? null;
    const m3Line = classifyToM3Line(row, subtype);
    const existing = groupsMap.get(m3Line) ?? [];
    existing.push({ ...row, m3Line });
    groupsMap.set(m3Line, existing);
  }

  const groups: M3LineGroup[] = [];
  let permanentTotal = new Decimal(0);
  let temporaryTotal = new Decimal(0);
  let unclassifiedTotal = new Decimal(0);

  for (const [m3Line, rows] of groupsMap.entries()) {
    const totalBookAmount = rows.reduce((acc, r) => acc.plus(r.bookAmount), new Decimal(0));
    const totalTaxAmount = rows.reduce((acc, r) => acc.plus(r.taxAmount), new Decimal(0));
    const totalDelta = rows.reduce((acc, r) => acc.plus(r.delta), new Decimal(0));

    // Classification: if all rows agree, use that; otherwise MIXED.
    const classes = new Set(rows.map((r) => r.classification));
    const classification: BtdClassification | "MIXED" =
      classes.size === 1 ? (classes.values().next().value as BtdClassification) : "MIXED";

    for (const r of rows) {
      if (r.classification === "PERMANENT") permanentTotal = permanentTotal.plus(r.delta);
      else if (r.classification === "TEMPORARY") temporaryTotal = temporaryTotal.plus(r.delta);
      else unclassifiedTotal = unclassifiedTotal.plus(r.delta);
    }

    groups.push({
      m3Line,
      rows: rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode)),
      totalBookAmount,
      totalTaxAmount,
      totalDelta,
      classification,
    });
  }

  // Display order: largest absolute delta first so material items lead.
  groups.sort((a, b) => Math.abs(b.totalDelta.toNumber()) - Math.abs(a.totalDelta.toNumber()));

  return {
    entityCode: input.entityCode,
    fromBookCode: input.fromBookCode,
    toBookCode: input.toBookCode,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    bookNetIncome: btd.bookNetIncome,
    taxNetIncome: btd.taxNetIncome,
    totalDelta: btd.totalDelta,
    groups,
    permanentTotal,
    temporaryTotal,
    unclassifiedTotal,
  };
}
