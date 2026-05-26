import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getBookTaxDifference } from "@/lib/accounting/reports/book-tax-difference";
import { getScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const scope = getScope();
  const bookFrom = url.searchParams.get("bookFrom") ?? scope.bookCode;
  const bookTo = url.searchParams.get("bookTo") ?? (bookFrom === "US_GAAP" ? "US_TAX" : "US_GAAP");

  const btd = await getBookTaxDifference(prisma, {
    entityCode: scope.entityCode,
    fromBookCode: bookFrom,
    toBookCode: bookTo,
    periodStart: new Date(from),
    periodEnd: new Date(to),
  });

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "BookTaxDifference",
    rowCount: btd.pnlRows.length + btd.balanceSheetRows.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows = [
    ["Book-Tax Difference", scope.entityCode, `${bookFrom} vs ${bookTo}`, `${from} to ${to}`],
    [],
    ["Summary", "", "", "Amount"],
    ["", "", "Book net income", btd.bookNetIncome.toFixed(2)],
    ["", "", "Tax net income", btd.taxNetIncome.toFixed(2)],
    ["", "", "Delta (book - tax)", btd.totalDelta.toFixed(2)],
    [],
    ["Section", "Code", "Account", "Type", "Book amount", "Tax amount", "Delta", "Classification", "Rationale"],
    ...btd.pnlRows.map((r) => [
      "P&L",
      r.accountCode,
      r.accountName,
      r.type,
      r.bookAmount.toFixed(2),
      r.taxAmount.toFixed(2),
      r.delta.toFixed(2),
      r.classification,
      r.rationale,
    ]),
    ...btd.balanceSheetRows.map((r) => [
      "BS",
      r.accountCode,
      r.accountName,
      r.type,
      r.bookAmount.toFixed(2),
      r.taxAmount.toFixed(2),
      r.delta.toFixed(2),
      r.classification,
      r.rationale,
    ]),
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(`btd_${bookFrom}_vs_${bookTo}`, `${from}_${to}`)}"`,
    },
  });
}
