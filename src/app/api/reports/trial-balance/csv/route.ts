import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getTrialBalance } from "@/lib/accounting/reports";
import { getScope } from "@/lib/scope";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const scope = getScope();
  const tb = await getTrialBalance(prisma, scope, new Date(asOf));

  const rows = [
    ["Trial Balance", scope.entityCode, scope.bookCode, `as of ${asOf}`],
    [],
    ["Code", "Account", "Type", "Debit", "Credit"],
    ...tb.rows
      .filter((r) => !r.debit.isZero() || !r.credit.isZero())
      .map((r) => [r.accountCode, r.accountName, r.type, r.debit.toFixed(2), r.credit.toFixed(2)]),
    ["", "", "TOTALS", tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2)],
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("trial-balance", asOf)}"`,
    },
  });
}
