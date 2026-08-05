import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import { FxRateNotFoundError } from "@/lib/accounting/fx";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
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
  const scope = await getCurrentScope();
  if (!scope) {
    return new NextResponse("No scope available — sign in and select a tenant", { status: 403 });
  }
  // Resolve the tenant BEFORE running the report: ?root= is
  // client-controlled, and the report's root lookup must be pinned to
  // the session tenant or a caller could name another tenant's entity
  // code and download that tenant's consolidated books.
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return new NextResponse("No tenant available — sign in and select a tenant", { status: 403 });
  }
  // periodStart activates ASC 830 translation (Phase B), mirroring the
  // page. Same graceful degradation: missing FX rates fall back to the
  // naïve-sum report rather than a 500 — the CSV then matches what the
  // page shows in that state.
  const periodStartParam = url.searchParams.get("periodStart");
  let report;
  try {
    report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: root,
      bookCode: scope.bookCode,
      asOf: new Date(asOf),
      ...(periodStartParam ? { periodStart: new Date(periodStartParam) } : {}),
      tenantId: tenant.id,
    });
  } catch (e) {
    if (!(e instanceof FxRateNotFoundError)) throw e;
    report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: root,
      bookCode: scope.bookCode,
      asOf: new Date(asOf),
      tenantId: tenant.id,
    });
  }

  const subCodes = report.entitiesIncluded.filter((e) => !e.isRoot).map((e) => e.code);

  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "Consolidation",
    resourceId: root,
    rowCount: report.rows.length,
    tenantId: tenant.id,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

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
