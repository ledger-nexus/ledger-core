// v0.9 NS SuiteAnalytics Phase 4 — Saved-Search query endpoint.
//
// POST /api/external/ns-analytics/saved-search
//   Authorization: Bearer <ledger-core API token>
//   Content-Type: application/json
//
// Body:
//   {
//     "searchType": "Account" | "Transaction",
//     "filters": [{"field": "...", "operator": "...", "values": [...]}, ...],
//     "columns": [{"field": "..."}, ...],
//     "page": 1,
//     "pageSize": 100
//   }
//
// Phase 4 ships Account + Transaction; Customer/Vendor/Item follow
// the same pattern in Phase 4.5.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  authenticateExternalRequest,
  auditExternalReportAccess,
} from "@/lib/external/ns-analytics-auth";
import {
  validateRequest,
  runSavedSearch,
  SavedSearchValidationError,
} from "@/lib/external/ns-saved-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Body cap: 100 KB. Saved-search requests are spec-only (no payloads);
// 100 KB is well above any reasonable filter set + column list.
const MAX_BODY_BYTES = 100 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  const auth = await authenticateExternalRequest(
    req,
    "ns-analytics/saved-search"
  );
  if (auth instanceof NextResponse) return auth;

  // Body size guard — read as text first to enforce a hard cap.
  // request.text() materializes the whole body but the next.js
  // ServerRequest doesn't expose Content-Length reliably; we count
  // bytes ourselves.
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        error: `Body too large (max ${MAX_BODY_BYTES} bytes for saved-search spec).`,
      },
      { status: 413 }
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  let request;
  try {
    request = validateRequest(parsedBody);
  } catch (err) {
    if (err instanceof SavedSearchValidationError) {
      return NextResponse.json(
        { error: err.message, field: err.field },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Invalid saved-search request." },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await runSavedSearch(prisma, {
      tenantId: auth.tenantId,
      request,
    });
  } catch (err) {
    // SOC 2 CC7.1: generic 500 + internal-only stack.
    console.error(
      "[ns-analytics/saved-search]",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { error: "Internal error running saved search." },
      { status: 500 }
    );
  }

  await auditExternalReportAccess({
    auth,
    endpoint: `ns-analytics/saved-search:${request.searchType}`,
    // Re-use the report-access audit shape with searchType in the
    // entityCode slot for filtering in the audit log.
    scope: { entityCode: request.searchType, bookCode: "" },
    rowCount: result.rows.length,
    ipAddress,
    userAgent,
  });

  return new NextResponse(
    JSON.stringify({
      _meta: {
        searchType: request.searchType,
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.total,
      },
      rows: result.rows,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // NS SuiteAnalytics returns total in a response header so
        // pagers can prefetch. Mirror the header so adapter tools
        // see what they expect.
        "X-Total-Count": String(result.total),
      },
    }
  );
}
