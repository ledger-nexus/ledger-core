// POST /api/internal/fixed-asset/dispose
//
// Trigger the disposal of a FixedAsset across every book it depreciates
// in. Wraps src/lib/accounting/sub-ledgers/fixed-assets.ts's
// disposeFixedAsset which:
//
//   1. Catches up depreciation through the disposal date (one
//      runDepreciation per book) so the disposal JE captures the right
//      accumulated balance.
//   2. Posts a disposal JE per book:
//        Dr Cash (proceeds, if any)
//        Dr Accumulated Depreciation (zero out the contra-asset)
//        Cr Equipment (gross cost)
//        Dr Loss / Cr Gain (the balancing line, based on proceeds vs NBV)
//   3. Marks FixedAsset.status = DISPOSED with disposalDate + proceeds.
//
// Same Bearer-token auth as the other /api/internal/* endpoints.
// Tenant scoping via the resolved token's tenantId.
//
// Wire format:
//   POST /api/internal/fixed-asset/dispose
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   {
//     assetCode: "FA-1001",
//     entityCode: "NORTHWIND",
//     disposalDate: "2026-09-30",          // ISO date
//     disposalProceeds: "5000.00",          // optional; default "0"
//     proceedsCashAccountCode: "1000",      // optional; default "1000"
//     gainLossAccountCode: "8100"           // optional; default "8100"
//   }
//
// Success (200):
//   {
//     ok: true,
//     results: [
//       {
//         bookCode: "US_GAAP",
//         entryNumber: "NORTHWIND-US_GAAP-00042",
//         proceeds: "5000.00",
//         nbvAtDisposal: "3000.00",
//         gainLoss: "2000.00"   // positive = gain, negative = loss
//       },
//       ...
//     ]
//   }
//
// Failure (4xx/5xx):
//   { ok: false, error: { code, message } }

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { disposeFixedAsset } from "@/lib/accounting/sub-ledgers/fixed-assets";
import {
  UnbalancedEntryError,
  InvalidLineError,
  UnknownAccountError,
  UnknownEntityError,
  UnknownBookError,
  PeriodClosedError,
  AccountBookScopeError,
  TenantScopeMismatchError,
} from "@/lib/accounting/types";
import { resolveBearerToken } from "@/lib/auth/token";
import { auditTokenUse } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JsonBody {
  assetCode: string;
  entityCode: string;
  disposalDate: string;
  disposalProceeds?: string | number;
  proceedsCashAccountCode?: string;
  gainLossAccountCode?: string;
}

type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "UNKNOWN_ASSET"
  | "ALREADY_DISPOSED"
  | "UNBALANCED"
  | "INVALID_LINE"
  | "UNKNOWN_ACCOUNT"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_BOOK"
  | "PERIOD_CLOSED"
  | "ACCOUNT_BOOK_SCOPE"
  | "TENANT_SCOPE"
  | "INTERNAL_ERROR";

function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const reqHeaders = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  if (!bearer) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/fixed-asset/dispose",
      reason: "Missing bearer token",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Missing bearer token", 401);
  }
  const identity = await resolveBearerToken(bearer);
  if (!identity) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/fixed-asset/dispose",
      reason: "Bearer token did not match any TenantApiToken or INTERNAL_API_TOKEN",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Invalid or revoked bearer token", 401);
  }
  await auditTokenUse({
    success: true,
    endpoint: "POST /api/internal/fixed-asset/dispose",
    tenantId: identity.tenantId ?? null,
    requestHeaders: reqHeaders,
  });

  let body: JsonBody;
  try {
    body = (await req.json()) as JsonBody;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  if (!body.assetCode || !body.entityCode || !body.disposalDate) {
    return err(
      "BAD_REQUEST",
      "Required: assetCode, entityCode, disposalDate",
      400
    );
  }

  const disposalDate = new Date(body.disposalDate);
  if (Number.isNaN(disposalDate.getTime())) {
    return err("BAD_REQUEST", `Invalid disposalDate "${body.disposalDate}"`, 400);
  }

  // Pre-check: asset exists in the caller's tenant. Friendlier error
  // than disposeFixedAsset's findFirstOrThrow when it's just "wrong
  // tenant" (which would otherwise look like "asset not found at all").
  if (identity.tenantId) {
    const exists = await prisma.fixedAsset.findFirst({
      where: {
        code: body.assetCode,
        entity: {
          code: body.entityCode,
          tenantId: identity.tenantId,
        },
      },
      select: { id: true, status: true },
    });
    if (!exists) {
      return err(
        "UNKNOWN_ASSET",
        `No FixedAsset with code "${body.assetCode}" under entity "${body.entityCode}" in this tenant`,
        422
      );
    }
    if (exists.status === "DISPOSED") {
      return err(
        "ALREADY_DISPOSED",
        `FixedAsset "${body.assetCode}" is already DISPOSED`,
        409
      );
    }
  }

  let proceeds: Decimal;
  try {
    proceeds = new Decimal(String(body.disposalProceeds ?? "0"));
    if (proceeds.isNegative()) {
      return err("BAD_REQUEST", "disposalProceeds must be ≥ 0", 400);
    }
  } catch {
    return err("BAD_REQUEST", `Invalid disposalProceeds "${body.disposalProceeds}"`, 400);
  }

  try {
    const results = await disposeFixedAsset(prisma, {
      tenantId: identity.tenantId ?? undefined,
      assetCode: body.assetCode,
      entityCode: body.entityCode,
      disposalDate,
      disposalProceeds: proceeds,
      proceedsCashAccountCode: body.proceedsCashAccountCode,
      gainLossAccountCode: body.gainLossAccountCode,
      source: "SYSTEM",
    });

    return NextResponse.json({
      ok: true,
      results: results.map((r) => ({
        bookCode: r.bookCode,
        entryNumber: r.entryNumber,
        proceeds: r.proceeds.toFixed(2),
        nbvAtDisposal: r.nbvAtDisposal.toFixed(2),
        gainLoss: r.gainLoss.toFixed(2),
      })),
    });
  } catch (e) {
    if (e instanceof UnknownEntityError)
      return err("UNKNOWN_ENTITY", e.message, 422);
    if (e instanceof UnknownBookError)
      return err("UNKNOWN_BOOK", e.message, 422);
    if (e instanceof UnknownAccountError)
      return err("UNKNOWN_ACCOUNT", e.message, 422);
    if (e instanceof UnbalancedEntryError)
      return err("UNBALANCED", e.message, 500); // shouldn't happen — disposal balances internally
    if (e instanceof InvalidLineError)
      return err("INVALID_LINE", e.message, 422);
    if (e instanceof PeriodClosedError)
      return err("PERIOD_CLOSED", e.message, 409);
    if (e instanceof AccountBookScopeError)
      return err("ACCOUNT_BOOK_SCOPE", e.message, 422);
    if (e instanceof TenantScopeMismatchError)
      return err("TENANT_SCOPE", e.message, 403);
    // Prisma's findFirstOrThrow becomes a NotFoundError without our types
    if (e instanceof Error && e.message.includes("No FixedAsset")) {
      return err("UNKNOWN_ASSET", e.message, 422);
    }
    if (e instanceof Error && e.message.includes("already DISPOSED")) {
      return err("ALREADY_DISPOSED", e.message, 409);
    }
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown server error",
      500
    );
  }
}
