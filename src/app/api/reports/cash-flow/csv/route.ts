import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCashFlowStatement } from "@/lib/accounting/reports/cash-flow";
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
  const cf = await getCashFlowStatement(prisma, scope, new Date(from), new Date(to));

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "CashFlowStatement",
    rowCount:
      cf.nonCashAddBacks.length +
      cf.workingCapitalChanges.length +
      cf.investingItems.length +
      cf.financingItems.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows = [
    ["Cash Flow Statement (indirect method)", scope.entityCode, scope.bookCode, `${from} to ${to}`],
    [],
    ["Section", "Code", "Account", "Amount", "Rationale"],
    ["Operating", "", "Net income", cf.netIncome.toFixed(2), "From income statement"],
    ...cf.nonCashAddBacks.map((l) => [
      "Operating",
      l.accountCode,
      l.accountName,
      l.cashImpact.toFixed(2),
      l.rationale,
    ]),
    ...cf.workingCapitalChanges.map((l) => [
      "Operating (WC)",
      l.accountCode,
      l.accountName,
      l.cashImpact.toFixed(2),
      l.rationale,
    ]),
    ["Operating", "", "TOTAL OPERATING", cf.operatingCashFlow.toFixed(2), ""],
    [],
    ...cf.investingItems.map((l) => [
      "Investing",
      l.accountCode,
      l.accountName,
      l.cashImpact.toFixed(2),
      l.rationale,
    ]),
    ["Investing", "", "TOTAL INVESTING", cf.investingCashFlow.toFixed(2), ""],
    [],
    ...cf.financingItems.map((l) => [
      "Financing",
      l.accountCode,
      l.accountName,
      l.cashImpact.toFixed(2),
      l.rationale,
    ]),
    ["Financing", "", "TOTAL FINANCING", cf.financingCashFlow.toFixed(2), ""],
    [],
    ["Total", "", "NET CHANGE IN CASH (computed)", cf.netCashFlow.toFixed(2), ""],
    ["Reconciliation", "", "Beginning cash", cf.beginningCash.toFixed(2), ""],
    ["Reconciliation", "", "Ending cash", cf.endingCash.toFixed(2), ""],
    ["Reconciliation", "", "Actual change in cash (BS)", cf.actualCashChange.toFixed(2), ""],
    [
      "Reconciliation",
      "",
      "Difference",
      cf.reconcilingDifference.toFixed(2),
      cf.reconciles ? "Reconciles" : "Does not reconcile — check UNCATEGORIZED",
    ],
    ...(cf.uncategorized.length
      ? [
          [],
          ["Uncategorized", "Code", "Account", "Delta", "Note"],
          ...cf.uncategorized.map((l) => [
            "Uncategorized",
            l.accountCode,
            l.accountName,
            l.deltaAmount.toFixed(2),
            "Not classified by v0.9 heuristic",
          ]),
        ]
      : []),
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("cash-flow", `${from}_${to}`)}"`,
    },
  });
}
