// v0.9 NS SuiteAnalytics Phase 1 — Balance Sheet endpoint.
//
// GET /api/external/ns-analytics/balance-sheet
//   ?entityCode=ACME_NS1 &bookCode=US_GAAP
//   &asOf=2026-04-30
//   [&format=json|csv]
//
// Mirror of the trial-balance and income-statement routes.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getBalanceSheet } from "@/lib/accounting/reports";
import {
  authenticateExternalRequest,
  auditExternalReportAccess,
  resolveScopeFromQuery,
} from "@/lib/external/ns-analytics-auth";
import { toNsBalanceSheet } from "@/lib/external/ns-report-shapes";

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
    "ns-analytics/balance-sheet"
  );
  if (auth instanceof NextResponse) return auth;

  const scope = await resolveScopeFromQuery(prisma, auth, url);
  if (scope instanceof NextResponse) return scope;
  const { entityCode, bookCode } = scope;

  const asOf = url.searchParams.get("asOf") ?? "";
  const format = url.searchParams.get("format") ?? "json";
  // v0.9 Phase 3.5 — shape discriminator mirrors trial-balance.
  const shape = url.searchParams.get("shape") ?? "native";

  if (!ISO_DATE_RX.test(asOf)) {
    return NextResponse.json(
      { error: "Invalid or missing asOf. Required: ISO YYYY-MM-DD." },
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

  let report: Awaited<ReturnType<typeof getBalanceSheet>>;
  try {
    report = await getBalanceSheet(
      prisma,
      { entityCode, bookCode, tenantId: auth.tenantId },
      new Date(asOf)
    );
  } catch (err) {
    console.error(
      "[ns-analytics/balance-sheet]",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { error: "Internal error generating balance sheet." },
      { status: 500 }
    );
  }

  await auditExternalReportAccess({
    auth,
    endpoint: "ns-analytics/balance-sheet",
    scope: { entityCode, bookCode },
    rowCount:
      report.assets.length + report.liabilities.length + report.equity.length,
    ipAddress,
    userAgent,
  });

  // v0.9 Phase 3.5 — NS-canonical shape branch (mirror of TB route).
  if (shape === "ns") {
    const nsBody = toNsBalanceSheet(
      {
        assets: report.assets,
        liabilities: report.liabilities,
        equity: report.equity,
      },
      {
        totalAssets: report.totalAssets,
        totalLiabilities: report.totalLiabilities,
        totalEquity: report.totalEquity,
        retainedEarnings: report.retainedEarnings,
        totalLiabilitiesAndEquity: report.totalLiabilitiesAndEquity,
      },
      report.balances,
      asOf,
      {
        subsidiaryInternalid: url.searchParams.get("subsidiary") ?? "",
        accountingBookInternalid: url.searchParams.get("accountingBook") ?? "",
      }
    );
    return NextResponse.json(nsBody);
  }

  const mapRow = (r: (typeof report.assets)[number]) => ({
    accountCode: r.code,
    accountName: r.name,
    amount: r.amount.toFixed(4),
    parentCode: r.parentCode,
    isContra: r.isContra,
  });

  const body = {
    _meta: {
      report: "balance-sheet",
      entityCode,
      bookCode,
      asOf,
      generatedAt: new Date().toISOString(),
    },
    assets: report.assets.map(mapRow),
    liabilities: report.liabilities.map(mapRow),
    equity: report.equity.map(mapRow),
    totals: {
      assets: report.totalAssets.toFixed(4),
      liabilities: report.totalLiabilities.toFixed(4),
      equity: report.totalEquity.toFixed(4),
      retainedEarnings: report.retainedEarnings.toFixed(4),
      liabilitiesAndEquity: report.totalLiabilitiesAndEquity.toFixed(4),
    },
    balances: report.balances,
  };

  if (format === "csv") {
    const csvRows = [
      ["section", "accountCode", "accountName", "amount"],
      ...body.assets.map((r) => ["Asset", r.accountCode, r.accountName, r.amount]),
      ...body.liabilities.map((r) => ["Liability", r.accountCode, r.accountName, r.amount]),
      ...body.equity.map((r) => ["Equity", r.accountCode, r.accountName, r.amount]),
      ["", "", "Total Assets", body.totals.assets],
      ["", "", "Total Liabilities & Equity", body.totals.liabilitiesAndEquity],
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ns-analytics-balance-sheet-${bookCode}-${asOf}.csv"`,
      },
    });
  }

  return NextResponse.json(body);
}
