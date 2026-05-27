// Trial Balance CSV export.
//
// Phase 7 hierarchy: parent accounts render with rolled-up Dr / Cr
// subtotals; leaves carry their own. ?flat=1 keeps the old
// one-row-per-account view for callers that want raw account data.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getTrialBalance } from "@/lib/accounting/reports";
import {
  buildHierarchy,
  flattenForDisplay,
  type FlatAccountRow,
} from "@/lib/accounting/account-hierarchy";
import { getScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv, csvFilename, type CsvCell } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const flat = url.searchParams.get("flat") === "1";
  const scope = getScope();
  const tb = await getTrialBalance(prisma, scope, new Date(asOf));

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "TrialBalance",
    rowCount: tb.rows.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // Keep rows with ANY activity. Pure-zero rows are noise.
  // Phase 7: also keep ANCESTOR rows of any row with activity — pure
  // group accounts ("1000 Current Assets") have no direct lines but
  // are load-bearing for the hierarchical subtotal. Walk parentCode
  // upward from every active row; collect every ancestor encountered.
  const parentByCode = new Map<string, string | null>();
  for (const r of tb.rows) parentByCode.set(r.accountCode, r.parentCode);
  const ancestorsNeeded = new Set<string>();
  for (const r of tb.rows) {
    const hasActivity =
      !new Decimal(r.debit.toString()).isZero() ||
      !new Decimal(r.credit.toString()).isZero();
    if (!hasActivity) continue;
    let cursor = r.parentCode;
    while (cursor && !ancestorsNeeded.has(cursor)) {
      ancestorsNeeded.add(cursor);
      cursor = parentByCode.get(cursor) ?? null;
    }
  }
  const nonZeroTBRows = tb.rows.filter(
    (r) =>
      !new Decimal(r.debit.toString()).isZero() ||
      !new Decimal(r.credit.toString()).isZero() ||
      ancestorsNeeded.has(r.accountCode)
  );

  let bodyRows: CsvCell[][];
  if (flat) {
    bodyRows = [
      ["Code", "Account", "Type", "Debit", "Credit"],
      ...nonZeroTBRows.map((r) => [
        r.accountCode,
        r.accountName,
        r.type,
        r.debit.toFixed(2),
        r.credit.toFixed(2),
      ]),
      ["", "", "TOTALS", tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2)],
    ];
  } else {
    const flatForHelper: FlatAccountRow[] = nonZeroTBRows.map((r) => ({
      code: r.accountCode,
      name: r.accountName,
      type: r.type,
      parentCode: r.parentCode,
      balance: new Decimal(r.balance.toString()),
      debit: new Decimal(r.debit.toString()),
      credit: new Decimal(r.credit.toString()),
      isContra: r.isContra,
    }));
    const tree = buildHierarchy(flatForHelper);
    const display = flattenForDisplay(tree);

    bodyRows = [
      ["Code", "Depth", "Account", "Type", "Group", "Debit", "Credit"],
      ...display.map((node): CsvCell[] => {
        const debit = node.hasChildren ? node.subtotalDebit : node.ownDebit;
        const credit = node.hasChildren ? node.subtotalCredit : node.ownCredit;
        const indent = "  ".repeat(node.depth);
        return [
          node.code,
          node.depth,
          `${indent}${node.name}`,
          node.type,
          node.hasChildren ? "subtotal" : "leaf",
          debit.toFixed(2),
          credit.toFixed(2),
        ];
      }),
      ["", "", "TOTALS", "", "", tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2)],
    ];
  }

  const rows: CsvCell[][] = [
    ["Trial Balance", scope.entityCode, scope.bookCode, `as of ${asOf}`],
    [],
    ...bodyRows,
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        flat ? "trial-balance-flat" : "trial-balance",
        asOf
      )}"`,
    },
  });
}
