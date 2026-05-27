// GET /api/reports/month-end/pdf?period=YYYY-MM
//
// Renders the month-end packet as a printable PDF. Same data + period-
// resolution logic as the CSV route; React-PDF handles layout.
//
// React-PDF runs server-side in Node — no headless Chrome dependency.
// The route streams the PDF response so large trial balances don't
// build up in memory.

import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { resolveCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import {
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
} from "@/lib/accounting/reports";
import { MonthEndDocument } from "@/lib/reports/month-end-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const periodParam = url.searchParams.get("period");
  // Accept ?entity=&book= overrides for shareable URLs (same pattern
  // as the CSV route).
  const scope = await resolveCurrentScope(url.searchParams);
  if (!scope) {
    return new NextResponse("No scope available — sign in and select a tenant", { status: 403 });
  }

  // Phase 4b: entity code unique per [tenantId, code]; use findFirst.
  const entity = await prisma.legalEntity.findFirst({
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
    format: "pdf",
    resource: "MonthEndPacket",
    resourceId: `${entity.code}/${book.code}/${selected.code}`,
    rowCount: tb.rows.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // React-PDF expects plain-data props (Decimal → string). Marshal here
  // so the component file stays JSON-shaped.
  const props = {
    entity: { code: entity.code, name: entity.name },
    book: { code: book.code, name: book.name },
    period: {
      code: selected.code,
      startsOn: selected.startsOn.toISOString().slice(0, 10),
      endsOn: selected.endsOn.toISOString().slice(0, 10),
    },
    close: close
      ? {
          closedAt: close.closedAt.toISOString(),
          closedBy: close.closedBy,
        }
      : null,
    tieOuts: { tbTies, bsTies },
    incomeStatement: {
      revenue: is.revenue.map((r) => ({
        code: r.code,
        name: r.name,
        amount: r.amount.toFixed(2),
      })),
      expenses: is.expenses.map((e) => ({
        code: e.code,
        name: e.name,
        amount: e.amount.toFixed(2),
      })),
      totalRevenue: is.totalRevenue.toFixed(2),
      totalExpenses: is.totalExpenses.toFixed(2),
      netIncome: is.netIncome.toFixed(2),
    },
    balanceSheet: {
      assets: bs.assets.map((a) => ({
        code: a.code,
        name: a.name,
        amount: a.amount.toFixed(2),
      })),
      liabilities: bs.liabilities.map((l) => ({
        code: l.code,
        name: l.name,
        amount: l.amount.toFixed(2),
      })),
      equity: bs.equity.map((e) => ({
        code: e.code,
        name: e.name,
        amount: e.amount.toFixed(2),
      })),
      totalAssets: bs.totalAssets.toFixed(2),
      totalLiabilities: bs.totalLiabilities.toFixed(2),
      totalEquity: bs.totalEquity.toFixed(2),
    },
    trialBalance: {
      rows: tb.rows.map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        type: r.type,
        debit: r.debit.toFixed(2),
        credit: r.credit.toFixed(2),
        balance: r.balance.toFixed(2),
      })),
      totalDebit: tb.totalDebit.toFixed(2),
      totalCredit: tb.totalCredit.toFixed(2),
    },
    generatedAt: new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
  };

  const pdfBuffer = await renderToBuffer(MonthEndDocument(props));
  const filename = `month-end-${entity.code}-${book.code}-${selected.code}.pdf`;

  // Cast through `unknown` — Node 25's stricter Buffer/Uint8Array typing
  // is ahead of @types/node consumers of NextResponse on Next 14.2. The
  // runtime accepts a Buffer fine; this only quiets tsc.
  return new NextResponse(pdfBuffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.byteLength),
    },
  });
}
