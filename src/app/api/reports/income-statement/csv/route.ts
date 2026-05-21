import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getIncomeStatement } from "@/lib/accounting/reports";
import { getScope } from "@/lib/scope";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const scope = getScope();
  const pnl = await getIncomeStatement(prisma, scope, new Date(from), new Date(to));

  const rows = [
    ["Income Statement", scope.entityCode, scope.bookCode, `${from} to ${to}`],
    [],
    ["Section", "Code", "Account", "Amount"],
    ...pnl.revenue.map((r) => ["Revenue", r.code, r.name, r.amount.toFixed(2)]),
    ["Revenue", "", "TOTAL REVENUE", pnl.totalRevenue.toFixed(2)],
    [],
    ...pnl.expenses.map((e) => ["Expense", e.code, e.name, e.amount.toFixed(2)]),
    ["Expense", "", "TOTAL EXPENSES", pnl.totalExpenses.toFixed(2)],
    [],
    ["Net income", "", "", pnl.netIncome.toFixed(2)],
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("income-statement", `${from}_${to}`)}"`,
    },
  });
}
