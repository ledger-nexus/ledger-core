import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import { getScope } from "@/lib/scope";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const root = url.searchParams.get("root");
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  if (!root) {
    return NextResponse.json({ error: "Missing ?root parameter" }, { status: 400 });
  }
  const scope = getScope();
  const report = await getConsolidatedTrialBalance(prisma, {
    rootEntityCode: root,
    bookCode: scope.bookCode,
    asOf: new Date(asOf),
  });

  const subCodes = report.entitiesIncluded.filter((e) => !e.isRoot).map((e) => e.code);

  const rows = [
    ["Consolidation", report.rootEntityName, report.bookCode, `as of ${asOf}`],
    [],
    ["Entities", ...report.entitiesIncluded.map((e) => `${e.code} (${e.isRoot ? "root" : "sub"})`)],
    [],
    ["Code", "Account", "Type", ...subCodes, "Sum (pre-elim)", "Eliminated", "Consolidated"],
    ...report.rows.map((r) => {
      const perByEntity = new Map(r.perEntity.map((p) => [p.entityCode, p]));
      const perCells = subCodes.map((c) => {
        const p = perByEntity.get(c);
        if (!p) return "";
        const net = new Decimal(p.debit.toString()).minus(new Decimal(p.credit.toString()));
        return net.toFixed(2);
      });
      return [
        r.accountCode,
        r.accountName,
        r.type,
        ...perCells,
        r.totalDebit.minus(r.totalCredit).toFixed(2),
        r.isEliminated ? r.eliminatedDebit.minus(r.eliminatedCredit).toFixed(2) : "",
        r.consolidatedBalance.toFixed(2),
      ];
    }),
    [],
    ["TOTALS (post-elim)", "", "", ...subCodes.map(() => ""), "", "", report.consolidatedTotalDebit.minus(report.consolidatedTotalCredit).toFixed(2)],
    ["Σ Dr post-elim", report.consolidatedTotalDebit.toFixed(2)],
    ["Σ Cr post-elim", report.consolidatedTotalCredit.toFixed(2)],
    ["Balanced?", report.balances ? "yes" : "no"],
    ["IC imbalance", report.netIcImbalance.toFixed(2)],
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(`consolidation_${root}`, asOf)}"`,
    },
  });
}
