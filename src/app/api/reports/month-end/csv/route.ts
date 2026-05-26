// GET /api/reports/month-end/csv?period=YYYY-MM
//
// Single CSV containing the three statements a controller looks at on
// `/reports/month-end`:
//   1. Header block (entity, book, period, close status)
//   2. Income statement
//   3. Balance sheet
//   4. Trial balance
//
// Sections are separated by blank rows. Excel imports this as one sheet
// with three logical tables — accountants then split-into-sheets or
// pivot however they prefer. The single-file approach is preferred over
// a zip-of-three because (a) one click to email a packet, (b) one file
// to attach to a workpaper.
//
// If ?period= is omitted, defaults to the latest CLOSED period for the
// active scope (matching the UI default). If no period is closed, falls
// back to the most recent period overall.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import {
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
} from "@/lib/accounting/reports";
import { toCsv, csvFilename, type CsvCell } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const periodParam = url.searchParams.get("period");
  // Accept ?entity=&book= overrides so a shareable demo URL renders
  // the right entity's packet without the user needing to switch
  // their sidebar scope cookie first.
  const scope = resolveScope(url.searchParams);

  const entity = await prisma.legalEntity.findUnique({
    where: { code: scope.entityCode },
    select: { id: true, code: true, name: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true, name: true },
  });
  if (!entity || !book) {
    return new NextResponse(
      `Scope not found: entity="${scope.entityCode}" book="${scope.bookCode}"`,
      { status: 404 }
    );
  }

  // Resolve the period (same logic as the UI page).
  const allPeriods = await prisma.period.findMany({
    where: { calendar: { entityId: entity.id } },
    orderBy: { startsOn: "desc" },
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });
  if (allPeriods.length === 0) {
    return new NextResponse("No periods seeded for this entity.", { status: 404 });
  }
  let selected = allPeriods[0];
  if (periodParam) {
    const match = allPeriods.find((p) => p.code === periodParam);
    if (!match) {
      return new NextResponse(
        `Unknown period "${periodParam}" for entity ${entity.code}.`,
        { status: 404 }
      );
    }
    selected = match;
  } else {
    const latestClose = await prisma.periodClose.findFirst({
      where: { entityId: entity.id, bookId: book.id },
      orderBy: { period: { startsOn: "desc" } },
      select: {
        period: { select: { id: true, code: true, startsOn: true, endsOn: true } },
      },
    });
    if (latestClose?.period) selected = latestClose.period;
  }

  const close = await prisma.periodClose.findUnique({
    where: {
      entityId_bookId_periodId: {
        entityId: entity.id,
        bookId: book.id,
        periodId: selected.id,
      },
    },
    select: { closedAt: true, closedBy: true },
  });

  const [tb, is, bs] = await Promise.all([
    getTrialBalance(prisma, scope, selected.endsOn),
    getIncomeStatement(prisma, scope, selected.startsOn, selected.endsOn),
    getBalanceSheet(prisma, scope, selected.endsOn),
  ]);

  const tbTies = tb.totalDebit.equals(tb.totalCredit);
  const bsTies = bs.totalAssets.equals(bs.totalLiabilities.plus(bs.totalEquity));

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "MonthEndPacket",
    resourceId: `${entity.code}/${book.code}/${selected.code}`,
    rowCount: tb.rows.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows: CsvCell[][] = [];
  rows.push(["Month-end Packet"]);
  rows.push(["Entity", entity.code, entity.name]);
  rows.push(["Book", book.code, book.name]);
  rows.push([
    "Period",
    selected.code,
    selected.startsOn.toISOString().slice(0, 10),
    "→",
    selected.endsOn.toISOString().slice(0, 10),
  ]);
  rows.push([
    "Status",
    close ? "CLOSED" : "OPEN",
    close ? `on ${close.closedAt.toISOString().slice(0, 10)}` : "",
    close ? `by ${close.closedBy ?? ""}` : "",
  ]);
  rows.push(["Tie-out", `TB DR=CR: ${tbTies ? "PASS" : "FAIL"}`, `BS A=L+E: ${bsTies ? "PASS" : "FAIL"}`]);
  rows.push([]);

  // ─── Income statement ────────────────────────────────────────────────
  rows.push(["Income statement", `${selected.startsOn.toISOString().slice(0, 10)} → ${selected.endsOn.toISOString().slice(0, 10)}`]);
  rows.push(["Code", "Account", "Amount"]);
  for (const r of is.revenue) {
    rows.push([r.code, r.name, r.amount.toFixed(2)]);
  }
  rows.push(["", "Total revenue", is.totalRevenue.toFixed(2)]);
  for (const e of is.expenses) {
    rows.push([e.code, e.name, e.amount.toFixed(2)]);
  }
  rows.push(["", "Total expenses", is.totalExpenses.toFixed(2)]);
  rows.push(["", "Net income", is.netIncome.toFixed(2)]);
  rows.push([]);

  // ─── Balance sheet ───────────────────────────────────────────────────
  rows.push(["Balance sheet", `as of ${selected.endsOn.toISOString().slice(0, 10)}`]);
  rows.push(["Code", "Account", "Balance"]);
  for (const a of bs.assets) {
    rows.push([a.code, a.name, a.amount.toFixed(2)]);
  }
  rows.push(["", "Total assets", bs.totalAssets.toFixed(2)]);
  for (const l of bs.liabilities) {
    rows.push([l.code, l.name, l.amount.toFixed(2)]);
  }
  rows.push(["", "Total liabilities", bs.totalLiabilities.toFixed(2)]);
  for (const e of bs.equity) {
    rows.push([e.code, e.name, e.amount.toFixed(2)]);
  }
  rows.push(["", "Total equity", bs.totalEquity.toFixed(2)]);
  rows.push(["", "Liabilities + Equity", bs.totalLiabilities.plus(bs.totalEquity).toFixed(2)]);
  rows.push([]);

  // ─── Trial balance ───────────────────────────────────────────────────
  rows.push(["Trial balance", `as of ${selected.endsOn.toISOString().slice(0, 10)}`]);
  rows.push(["Code", "Account", "Type", "Debit", "Credit", "Balance"]);
  for (const r of tb.rows.filter((r) => !r.debit.isZero() || !r.credit.isZero())) {
    rows.push([
      r.accountCode,
      r.accountName,
      r.type,
      r.debit.toFixed(2),
      r.credit.toFixed(2),
      r.balance.toFixed(2),
    ]);
  }
  rows.push(["", "TOTALS", "", tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2), ""]);

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        `month-end-${entity.code}-${book.code}`,
        selected.code
      )}"`,
    },
  });
}
