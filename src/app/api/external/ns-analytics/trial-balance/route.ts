// v0.9 NS SuiteAnalytics Phase 1 — Trial Balance endpoint.
//
// GET /api/external/ns-analytics/trial-balance
//   Authorization: Bearer <ledger-core API token>
//   ?entityCode=ACME_NS1
//   &bookCode=US_GAAP
//   &asOf=2026-04-30
//   [&format=json|csv]      (default json)
//
// Phase 1 ships ledger-core-NATIVE shape. The Phase 3 shape mapper
// will translate to NS-canonical JSON (accountnumber / acctname /
// debitamount / creditamount / subsidiary.internalid / etc.). This
// PR is the auth + endpoint scaffold the next phases build on.
//
// Why ledger-core-native now: Phase 1 is operator-facing
// "bootstrap me with reports I can hit" while Phase 2 (NS internalid
// resolution) and Phase 3 (NS shape) land. Callers wanting NS shape
// can map themselves until Phase 3 ships.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getTrialBalance } from "@/lib/accounting/reports";
import {
  authenticateExternalRequest,
  auditExternalReportAccess,
  resolveScopeFromQuery,
  fetchAccountSubtypeHints,
} from "@/lib/external/ns-analytics-auth";
import { toNsTrialBalance } from "@/lib/external/ns-report-shapes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Date validation lives at the route level; scope (entity/book) is
// validated by resolveScopeFromQuery.
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  // ---- 1. Auth gate first (don't even parse query on unauth) -------
  const auth = await authenticateExternalRequest(
    req,
    "ns-analytics/trial-balance"
  );
  if (auth instanceof NextResponse) return auth;

  // ---- 2. Resolve scope (NS-side OR ledger-core-native) -------------
  const scope = await resolveScopeFromQuery(prisma, auth, url);
  if (scope instanceof NextResponse) return scope;
  const { entityCode, bookCode } = scope;

  const asOf = url.searchParams.get("asOf") ?? "";
  const format = url.searchParams.get("format") ?? "json";
  // v0.9 Phase 3 — shape discriminator. "native" keeps the ledger-core
  // shape from Phase 1; "ns" returns the SuiteAnalytics-canonical
  // JSON (accttype / acctnumber / subsidiary.internalid / etc.).
  // Default stays "native" so Phase 1 callers see no change.
  const shape = url.searchParams.get("shape") ?? "native";

  if (!ISO_DATE_RX.test(asOf)) {
    return NextResponse.json(
      { error: "Invalid or missing asOf. Required: ISO date YYYY-MM-DD." },
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
  // NS shape requires NS-side scope (so subsidiary.internalid /
  // accountingBook.internalid in the response are real NS ids that the
  // operator passed). Mixing shape=ns with native-mode scope params is
  // operator confusion → 400.
  if (shape === "ns" && scope.source !== "ns") {
    return NextResponse.json(
      {
        error:
          'shape=ns requires NS-side scope (subsidiary + accountingBook). Use shape=native with entityCode + bookCode.',
      },
      { status: 400 }
    );
  }

  // ---- 3. Run the report -------------------------------------------
  let report: Awaited<ReturnType<typeof getTrialBalance>>;
  try {
    report = await getTrialBalance(
      prisma,
      { entityCode, bookCode, tenantId: auth.tenantId },
      new Date(asOf)
    );
  } catch (err) {
    // SOC 2 CC7.1: surface generic 500, log internal detail to console
    // + audit. Never leak DB / stack to the caller.
    const internalMessage =
      err instanceof Error ? err.message : String(err);
    console.error("[ns-analytics/trial-balance]", internalMessage);
    return NextResponse.json(
      { error: "Internal error generating trial balance." },
      { status: 500 }
    );
  }

  // ---- 4. Audit + return -------------------------------------------
  await auditExternalReportAccess({
    auth,
    endpoint: "ns-analytics/trial-balance",
    scope: { entityCode, bookCode },
    rowCount: report.rows.length,
    ipAddress,
    userAgent,
  });

  // v0.9 Phase 3 — NS-canonical shape branch. The mapper is a pure
  // function — no DB access — so this is just a shape transform.
  if (shape === "ns") {
    // Subtype-refined NS accttype mapping (Bank vs OthCurAsset etc.).
    const hints = await fetchAccountSubtypeHints(
      prisma,
      auth.tenantId,
      report.rows.map((r) => r.accountCode)
    );
    const nsBody = toNsTrialBalance(
      report.rows,
      { totalDebit: report.totalDebit, totalCredit: report.totalCredit },
      asOf,
      {
        subsidiaryInternalid: url.searchParams.get("subsidiary") ?? "",
        accountingBookInternalid: url.searchParams.get("accountingBook") ?? "",
      },
      hints
    );
    return NextResponse.json(nsBody);
  }

  const body = {
    _meta: {
      report: "trial-balance",
      entityCode,
      bookCode,
      asOf,
      generatedAt: new Date().toISOString(),
      rowCount: report.rows.length,
    },
    totals: {
      debit: report.totalDebit.toFixed(4),
      credit: report.totalCredit.toFixed(4),
    },
    rows: report.rows.map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      type: r.type,
      debit: r.debit.toFixed(4),
      credit: r.credit.toFixed(4),
      balance: r.balance.toFixed(4),
      parentCode: r.parentCode,
      isContra: r.isContra,
    })),
  };

  if (format === "csv") {
    const csvRows = [
      ["accountCode", "accountName", "type", "debit", "credit", "balance", "parentCode", "isContra"],
      ...body.rows.map((r) => [
        r.accountCode,
        r.accountName,
        r.type,
        r.debit,
        r.credit,
        r.balance,
        r.parentCode ?? "",
        String(r.isContra),
      ]),
    ];
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ns-analytics-trial-balance-${bookCode}-${asOf}.csv"`,
      },
    });
  }

  return NextResponse.json(body);
}
