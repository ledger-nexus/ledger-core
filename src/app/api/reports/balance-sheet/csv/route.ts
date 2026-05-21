import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getBalanceSheet } from "@/lib/accounting/reports";
import { getScope } from "@/lib/scope";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const scope = getScope();
  const bs = await getBalanceSheet(prisma, scope, new Date(asOf));

  const rows = [
    ["Balance Sheet", scope.entityCode, scope.bookCode, `as of ${asOf}`],
    [],
    ["Section", "Code", "Account", "Amount"],
    ...bs.assets.map((a) => ["Asset", a.code, a.name, a.amount.toFixed(2)]),
    ["Asset", "", "TOTAL ASSETS", bs.totalAssets.toFixed(2)],
    [],
    ...bs.liabilities.map((l) => ["Liability", l.code, l.name, l.amount.toFixed(2)]),
    ["Liability", "", "TOTAL LIABILITIES", bs.totalLiabilities.toFixed(2)],
    [],
    ...bs.equity.map((e) => ["Equity", e.code, e.name, e.amount.toFixed(2)]),
    ["Equity", "", "TOTAL EQUITY", bs.totalEquity.toFixed(2)],
    [],
    ["Check", "", "Assets = Liabilities + Equity", bs.balances ? "BALANCED" : "UNBALANCED"],
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("balance-sheet", asOf)}"`,
    },
  });
}
