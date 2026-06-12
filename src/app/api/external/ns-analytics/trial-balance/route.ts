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
} from "@/lib/external/ns-analytics-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shape-validate operator inputs. These regexes protect against
// control chars / injection / cross-tenant probes. Same shape rules
// used by /import/netsuite Server Action (PR #143).
const ENTITY_CODE_RX = /^[A-Z0-9_-]{1,32}$/i;
const BOOK_CODE_RX = /^[A-Z0-9_]{1,32}$/i;
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

  // ---- 2. Parse + validate query params ----------------------------
  const entityCode = url.searchParams.get("entityCode") ?? "";
  const bookCode = url.searchParams.get("bookCode") ?? "";
  const asOf = url.searchParams.get("asOf") ?? "";
  const format = url.searchParams.get("format") ?? "json";

  if (!ENTITY_CODE_RX.test(entityCode)) {
    return NextResponse.json(
      { error: "Invalid or missing entityCode. Required: 1–32 ASCII letters/digits/underscores/dashes." },
      { status: 400 }
    );
  }
  if (!BOOK_CODE_RX.test(bookCode)) {
    return NextResponse.json(
      { error: "Invalid or missing bookCode. Required: 1–32 ASCII letters/digits/underscores." },
      { status: 400 }
    );
  }
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
