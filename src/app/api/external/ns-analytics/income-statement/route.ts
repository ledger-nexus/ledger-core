// v0.9 NS SuiteAnalytics Phase 1 — Income Statement endpoint.
//
// GET /api/external/ns-analytics/income-statement
//   ?entityCode=ACME_NS1 &bookCode=US_GAAP
//   &fromDate=2026-04-01 &toDate=2026-04-30
//   [&format=json|csv]
//
// Mirror of trial-balance route — same auth + same validation shape.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getIncomeStatement } from "@/lib/accounting/reports";
import {
  authenticateExternalRequest,
  auditExternalReportAccess,
  resolveScopeFromQuery,
} from "@/lib/external/ns-analytics-auth";
import { toNsIncomeStatement } from "@/lib/external/ns-report-shapes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  const auth = await authenticateExternalRequest(
    req,
    "ns-analytics/income-statement"
  );
  if (auth instanceof NextResponse) return auth;

  const scope = await resolveScopeFromQuery(prisma, auth, url);
  if (scope instanceof NextResponse) return scope;
  const { entityCode, bookCode } = scope;

  const fromDate = url.searchParams.get("fromDate") ?? "";
  const toDate = url.searchParams.get("toDate") ?? "";
  const format = url.searchParams.get("format") ?? "json";
  // v0.9 Phase 3.5 — shape discriminator mirrors trial-balance.
  const shape = url.searchParams.get("shape") ?? "native";

  if (!ISO_DATE_RX.test(fromDate) || !ISO_DATE_RX.test(toDate)) {
    return NextResponse.json(
      { error: "Invalid or missing fromDate/toDate. Required: ISO YYYY-MM-DD." },
      { status: 400 }
    );
  }
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: 'Invalid format. Required: "json" or "csv".' },
      { status: 400 }
    );
  }
  if (shape !== "native" && shape !== "ns") {
    return NextResponse.json(
      { error: 'Invalid shape. Required: "native" or "ns".' },
      { status: 400 }
    );
  }
  if (shape === "ns" && scope.source !== "ns") {
    return NextResponse.json(
      {
        error:
          'shape=ns requires NS-side scope (subsidiary + accountingBook). Use shape=native with entityCode + bookCode.',
      },
      { status: 400 }
    );
  }

  let report: Awaited<ReturnType<typeof getIncomeStatement>>;
  try {
    report = await getIncomeStatement(
      prisma,
      { entityCode, bookCode, tenantId: auth.tenantId },
      new Date(fromDate),
      new Date(toDate)
    );
  } catch (err) {
    console.error(
      "[ns-analytics/income-statement]",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { error: "Internal error generating income statement." },
      { status: 500 }
    );
  }

  await auditExternalReportAccess({
    auth,
    endpoint: "ns-analytics/income-statement",
    scope: { entityCode, bookCode },
    rowCount: report.revenue.length + report.expenses.length,
    ipAddress,
    userAgent,
  });

  // v0.9 Phase 3.5 — NS-canonical shape branch (mirror of TB route).
  if (shape === "ns") {
    const nsBody = toNsIncomeStatement(
      report.revenue,
      report.expenses,
      {
        totalRevenue: report.totalRevenue,
        totalExpenses: report.totalExpenses,
        netIncome: report.netIncome,
      },
      { fromDate, toDate },
      {
        subsidiaryInternalid: url.searchParams.get("subsidiary") ?? "",
        accountingBookInternalid: url.searchParams.get("accountingBook") ?? "",
      }
    );
    return NextResponse.json(nsBody);
  }

  const body = {
    _meta: {
      report: "income-statement",
      entityCode,
      bookCode,
      fromDate,
      toDate,
      generatedAt: new Date().toISOString(),
    },
    revenue: report.revenue.map((r) => ({
      accountCode: r.code,
      accountName: r.name,
      amount: r.amount.toFixed(4),
      parentCode: r.parentCode,
      isContra: r.isContra,
    })),
    expenses: report.expenses.map((r) => ({
      accountCode: r.code,
      accountName: r.name,
      amount: r.amount.toFixed(4),
      parentCode: r.parentCode,
      isContra: r.isContra,
    })),
    totals: {
      revenue: report.totalRevenue.toFixed(4),
      expenses: report.totalExpenses.toFixed(4),
      netIncome: report.netIncome.toFixed(4),
    },
  };

  if (format === "csv") {
    const csvRows = [
      ["section", "accountCode", "accountName", "amount"],
      ...body.revenue.map((r) => ["Revenue", r.accountCode, r.accountName, r.amount]),
      ...body.expenses.map((r) => ["Expense", r.accountCode, r.accountName, r.amount]),
      ["", "", "Net income", body.totals.netIncome],
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ns-analytics-income-statement-${bookCode}-${fromDate}_${toDate}.csv"`,
      },
    });
  }

  return NextResponse.json(body);
}
