// POST /api/internal/fixed-asset/impair
//
// Triggers the ASC 360-10 Step 2 measurement write-down on a FixedAsset.
// Mirror of /api/internal/fixed-asset/dispose's wire shape — Bearer
// auth, tenant scope, per-book amounts.
//
// What it does (via impairFixedAsset in sub-ledgers/fixed-assets.ts):
//
//   1. Catches up depreciation through the impairment date per book
//   2. For each book in amountByBook with a positive value, posts a JE:
//        Dr Impairment Loss      <amount>
//        Cr Accumulated Depreciation  <amount>
//      and bumps FixedAssetBookAttributes.accumulatedDepreciation.
//   3. Refuses if any book's amount > current NBV (can't write below 0).
//   4. Asset stays IN_SERVICE — only NBV decreases.
//
// Per-book amounts differ because impairment is GAAP-only in practice:
// the CPA passes the impairment amount per book and skips books that
// don't impair (typically TAX). One round-trip impairs as many books
// as the CPA wants.
//
// Wire format:
//   POST /api/internal/fixed-asset/impair
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   {
//     assetCode: "FA-1001",
//     entityCode: "NORTHWIND",
//     impairmentDate: "2026-09-30",
//     amountByBook: {
//       "US_GAAP": "3000.00",
//       "IFRS":    "3000.00"
//     },
//     impairmentLossAccountCode: "8200",  // optional; default "8200"
//     sourceSuggestionId: "ai-asset-suggestion-uuid"  // optional
//   }
//
// Success (200):
//   {
//     ok: true,
//     results: [
//       {
//         bookCode: "US_GAAP",
//         entryNumber: "NORTHWIND-US_GAAP-00043",
//         nbvBeforeImpairment: "5000.00",
//         lossAmount: "3000.00",
//         nbvAfterImpairment: "2000.00"
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
import { impairFixedAsset } from "@/lib/accounting/sub-ledgers/fixed-assets";
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
  impairmentDate: string;
  amountByBook: Record<string, string | number>;
  impairmentLossAccountCode?: string;
  sourceSuggestionId?: string;
}

type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "UNKNOWN_ASSET"
  | "ASSET_DISPOSED"
  | "IMPAIRMENT_EXCEEDS_NBV"
  | "NO_AMOUNTS"
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
      endpoint: "POST /api/internal/fixed-asset/impair",
      reason: "Missing bearer token",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Missing bearer token", 401);
  }
  const identity = await resolveBearerToken(bearer);
  if (!identity) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/fixed-asset/impair",
      reason: "Bearer token did not match any TenantApiToken or INTERNAL_API_TOKEN",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Invalid or revoked bearer token", 401);
  }
  await auditTokenUse({
    success: true,
    endpoint: "POST /api/internal/fixed-asset/impair",
    tenantId: identity.tenantId ?? null,
    requestHeaders: reqHeaders,
  });

  let body: JsonBody;
  try {
    body = (await req.json()) as JsonBody;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  if (
    !body.assetCode ||
    !body.entityCode ||
    !body.impairmentDate ||
    !body.amountByBook ||
    typeof body.amountByBook !== "object"
  ) {
    return err(
      "BAD_REQUEST",
      "Required: assetCode, entityCode, impairmentDate, amountByBook (object mapping bookCode -> amount)",
      400
    );
  }

  const impairmentDate = new Date(body.impairmentDate);
  if (Number.isNaN(impairmentDate.getTime())) {
    return err("BAD_REQUEST", `Invalid impairmentDate "${body.impairmentDate}"`, 400);
  }

  // Validate amounts: each must parse as a finite Decimal. We let
  // impairFixedAsset enforce > 0 and ≤ NBV.
  const amountByBook: Record<string, Decimal> = {};
  let anyPositive = false;
  for (const [bookCode, raw] of Object.entries(body.amountByBook)) {
    let d: Decimal;
    try {
      d = new Decimal(String(raw));
    } catch {
      return err("BAD_REQUEST", `Invalid amount for book "${bookCode}": ${raw}`, 400);
    }
    if (!d.isFinite()) {
      return err("BAD_REQUEST", `Amount for book "${bookCode}" is not finite`, 400);
    }
    if (d.isNegative()) {
      return err(
        "BAD_REQUEST",
        `Amount for book "${bookCode}" can't be negative (got ${d.toString()})`,
        400
      );
    }
    amountByBook[bookCode] = d;
    if (d.greaterThan(0)) anyPositive = true;
  }
  if (!anyPositive) {
    return err(
      "NO_AMOUNTS",
      "amountByBook has no positive values — nothing to impair. Pass at least one book with a positive amount.",
      400
    );
  }

  // Pre-check the asset exists in the caller's tenant for a cleaner error.
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
        "ASSET_DISPOSED",
        `FixedAsset "${body.assetCode}" is DISPOSED; can't impair a disposed asset.`,
        409
      );
    }
  }

  try {
    const results = await impairFixedAsset(prisma, {
      tenantId: identity.tenantId ?? undefined,
      assetCode: body.assetCode,
      entityCode: body.entityCode,
      impairmentDate,
      amountByBook,
      impairmentLossAccountCode: body.impairmentLossAccountCode,
      sourceSuggestionId: body.sourceSuggestionId,
      source: "SYSTEM",
    });

    return NextResponse.json({
      ok: true,
      results: results.map((r) => ({
        bookCode: r.bookCode,
        entryNumber: r.entryNumber,
        nbvBeforeImpairment: r.nbvBeforeImpairment.toFixed(2),
        lossAmount: r.lossAmount.toFixed(2),
        nbvAfterImpairment: r.nbvAfterImpairment.toFixed(2),
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
      return err("UNBALANCED", e.message, 500);
    if (e instanceof InvalidLineError)
      return err("INVALID_LINE", e.message, 422);
    if (e instanceof PeriodClosedError)
      return err("PERIOD_CLOSED", e.message, 409);
    if (e instanceof AccountBookScopeError)
      return err("ACCOUNT_BOOK_SCOPE", e.message, 422);
    if (e instanceof TenantScopeMismatchError)
      return err("TENANT_SCOPE", e.message, 403);
    if (e instanceof Error && e.message.includes("exceeds NBV")) {
      return err("IMPAIRMENT_EXCEEDS_NBV", e.message, 422);
    }
    if (e instanceof Error && e.message.includes("No FixedAsset")) {
      return err("UNKNOWN_ASSET", e.message, 422);
    }
    if (e instanceof Error && e.message.includes("DISPOSED")) {
      return err("ASSET_DISPOSED", e.message, 409);
    }
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown server error",
      500
    );
  }
}
