// Income Statement CSV export.
//
// Phase 7 hierarchy: same shape as the BS CSV — parent groups roll up
// to subtotals, leaves carry their own activity. ?flat=1 swaps to the
// old per-account-only view.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getIncomeStatement, type FinancialStatementRow } from "@/lib/accounting/reports";
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
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const flat = url.searchParams.get("flat") === "1";
  const scope = getScope();
  const pnl = await getIncomeStatement(prisma, scope, new Date(from), new Date(to));

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "IncomeStatement",
    rowCount: pnl.revenue.length + pnl.expenses.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows: CsvCell[][] = [
    ["Income Statement", scope.entityCode, scope.bookCode, `${from} to ${to}`],
    [],
    flat
      ? ["Section", "Code", "Account", "Amount"]
      : ["Section", "Code", "Depth", "Account", "Type", "Amount"],
    ...emitSection("Revenue", "TOTAL REVENUE", pnl.revenue, pnl.totalRevenue, flat),
    [],
    ...emitSection("Expense", "TOTAL EXPENSES", pnl.expenses, pnl.totalExpenses, flat),
    [],
    flat
      ? ["Net income", "", "", pnl.netIncome.toFixed(2)]
      : ["Net income", "", "", "", "", pnl.netIncome.toFixed(2)],
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        flat ? "income-statement-flat" : "income-statement",
        `${from}_${to}`
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
      ...sectionRows.map((r) => [
        sectionLabel,
        r.code,
        r.name,
        r.amount.toFixed(2),
      ]),
      [sectionLabel, "", totalLabel, total.toFixed(2)],
    ];
  }

  const flatForHelper: FlatAccountRow[] = sectionRows.map((r) => ({
    code: r.code,
    name: r.name,
    type: "REVENUE",
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
