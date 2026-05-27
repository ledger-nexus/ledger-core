// Balance Sheet CSV export.
//
// Phase 7 hierarchy: renders parent accounts with their recursive
// subtotal + indented children. ?flat=1 swaps to the old flat view
// for callers (auditors, spreadsheet pipelines) that want one row
// per account with no grouping.
//
// Format (hierarchical, default):
//   Header rows, then a blank, then:
//     Section, Code, Depth, Account, Type, Amount
//   Where Type is "subtotal" for group accounts (has children) or
//   "leaf" for ordinary accounts. The Account column is leading-space-
//   indented to depth so the file is readable as-is in Excel.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getBalanceSheet, type FinancialStatementRow } from "@/lib/accounting/reports";
import {
  buildHierarchy,
  flattenForDisplay,
  type FlatAccountRow,
} from "@/lib/accounting/account-hierarchy";
import { getScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv, csvFilename, type CsvCell } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const flat = url.searchParams.get("flat") === "1";
  const scope = getScope();
  const bs = await getBalanceSheet(prisma, scope, new Date(asOf));

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "BalanceSheet",
    rowCount: bs.assets.length + bs.liabilities.length + bs.equity.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows: CsvCell[][] = [
    ["Balance Sheet", scope.entityCode, scope.bookCode, `as of ${asOf}`],
    [],
    flat
      ? ["Section", "Code", "Account", "Amount"]
      : ["Section", "Code", "Depth", "Account", "Type", "Amount"],
    ...emitSection("Asset", "TOTAL ASSETS", bs.assets, bs.totalAssets, flat),
    [],
    ...emitSection("Liability", "TOTAL LIABILITIES", bs.liabilities, bs.totalLiabilities, flat),
    [],
    ...emitSection("Equity", "TOTAL EQUITY", bs.equity, bs.totalEquity, flat),
    [],
    flat
      ? ["Check", "", "Assets = Liabilities + Equity", bs.balances ? "BALANCED" : "UNBALANCED"]
      : ["Check", "", "", "Assets = Liabilities + Equity", "", bs.balances ? "BALANCED" : "UNBALANCED"],
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        flat ? "balance-sheet-flat" : "balance-sheet",
        asOf
      )}"`,
    },
  });
}

function emitSection(
  sectionLabel: string,
  totalLabel: string,
  sectionRows: FinancialStatementRow[],
  total: Decimal,
  flat: boolean
): CsvCell[][] {
  if (flat) {
    return [
      ...sectionRows.map((a) => [
        sectionLabel,
        a.code,
        a.name,
        a.amount.toFixed(2),
      ]),
      [sectionLabel, "", totalLabel, total.toFixed(2)],
    ];
  }

  const flatForHelper: FlatAccountRow[] = sectionRows.map((r) => ({
    code: r.code,
    name: r.name,
    type: "ASSET", // placeholder — type not used by buildHierarchy
    parentCode: r.parentCode,
    balance: new Decimal(r.amount.toString()),
    debit: new Decimal(0),
    credit: new Decimal(0),
    isContra: r.isContra,
  }));
  const tree = buildHierarchy(flatForHelper);
  const display = flattenForDisplay(tree);
  return [
    ...display.map((node): CsvCell[] => {
      const value = node.hasChildren ? node.subtotalBalance : node.ownBalance;
      // Visual indent in the Account column; Depth column is the
      // machine-friendly version of the same info.
      const indent = "  ".repeat(node.depth);
      return [
        sectionLabel,
        node.code,
        node.depth,
        `${indent}${node.name}`,
        node.hasChildren ? "subtotal" : "leaf",
        value.toFixed(2),
      ];
    }),
    [sectionLabel, "", "", totalLabel, "total", total.toFixed(2)],
  ];
}
