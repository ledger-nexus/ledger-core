import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getM3Detail } from "@/lib/accounting/reports/m3-detail";
import { getScope } from "@/lib/scope";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const scope = getScope();
  const bookFrom = url.searchParams.get("bookFrom") ?? "US_GAAP";
  const bookTo = url.searchParams.get("bookTo") ?? "US_TAX";

  const report = await getM3Detail(prisma, {
    entityCode: scope.entityCode,
    fromBookCode: bookFrom,
    toBookCode: bookTo,
    periodStart: new Date(from),
    periodEnd: new Date(to),
  });

  const rows: (string | number)[][] = [
    ["M-3 Detail", scope.entityCode, `${bookFrom} vs ${bookTo}`, `${from} to ${to}`],
    [],
    ["Book net income", report.bookNetIncome.toFixed(2)],
    ["Tax net income", report.taxNetIncome.toFixed(2)],
    ["Total delta (book - tax)", report.totalDelta.toFixed(2)],
    ["Permanent differences", report.permanentTotal.toFixed(2)],
    ["Temporary differences", report.temporaryTotal.toFixed(2)],
    ["Unclassified differences", report.unclassifiedTotal.toFixed(2)],
    [],
    ["M-3 Line", "Code", "Account", "Type", "Book", "Tax", "Delta", "Classification"],
  ];

  for (const group of report.groups) {
    for (const r of group.rows) {
      rows.push([
        group.m3Line,
        r.accountCode,
        r.accountName,
        r.type,
        r.bookAmount.toFixed(2),
        r.taxAmount.toFixed(2),
        r.delta.toFixed(2),
        r.classification,
      ]);
    }
    rows.push([
      `${group.m3Line} · Total`,
      "",
      "",
      "",
      "",
      "",
      group.totalDelta.toFixed(2),
      group.classification,
    ]);
  }

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("m3-detail", `${from}_${to}`)}"`,
    },
  });
}
