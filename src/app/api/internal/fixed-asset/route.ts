// POST /api/internal/fixed-asset
//
// Internal endpoint for trusted sibling repos (today: fa-amort's
// "Accept AI capex suggestion" flow) to create a FixedAsset row +
// its per-book FixedAssetBookAttributes without writing to the
// substrate directly. Wraps `createFixedAsset` in the canonical
// transaction.
//
// Gated by INTERNAL_API_TOKEN. Fails closed if unset.
//
// Idempotency: per-call dedupe on the (entityCode, assetCode) tuple
// — calling twice with the same identifiers returns the existing
// asset's id with `wasDuplicate: true`. Lets the Accept flow be
// retried after a partial UI failure without creating a second
// asset row.
//
// Wire format:
//   POST /api/internal/fixed-asset
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   {
//     entityCode: "NORTHWIND",
//     code: "FA-LAPTOPS-2026-005",
//     description: "4× Cisco Catalyst switches",
//     category: "COMPUTER_EQUIPMENT",   // optional
//     vendorPartyCode: "CISCO",          // optional
//     acquisitionDate: "2026-05-15",     // ISO date
//     acquisitionCost: "14000.00",       // decimal string
//     acquisitionCurrencyCode: "USD",
//     assetAccountCode: "1500",
//     books: [
//       {
//         bookCode: "US_GAAP",
//         usefulLifeMonths: 60,
//         method: "STRAIGHT_LINE",
//         inServiceDate: "2026-05-15",
//         salvageValue: "0",
//         depreciationExpenseAccountCode: "8000",
//         accumDepreciationAccountCode: "1510"
//       },
//       ...
//     ],
//     sourceSystem: "fa-amort",
//     sourceRecordType: "AiCapexSuggestion",
//     sourceRecordId: "<AiAssetSuggestion.id>"
//   }
//
// Success (200):
//   { ok: true, id, code, wasDuplicate?: boolean }
//
// Failure (4xx/5xx):
//   { ok: false, error: { code, message } }
//   - code: UNAUTHORIZED, BAD_REQUEST, UNKNOWN_ENTITY, UNKNOWN_BOOK,
//     UNKNOWN_VENDOR, INTERNAL_ERROR.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import {
  createFixedAssetInTx,
  type FixedAssetBookSpec,
} from "@/lib/accounting/sub-ledgers/fixed-assets";
import { resolveBearerToken } from "@/lib/auth/token";
import { auditTokenUse } from "@/lib/audit/log";
import { withTenantContext } from "@/lib/db/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_BOOK"
  | "UNKNOWN_VENDOR"
  | "INTERNAL_ERROR";

function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

interface BookInput {
  bookCode: string;
  usefulLifeMonths: number;
  method: FixedAssetBookSpec["method"];
  inServiceDate: string;
  salvageValue?: string | number;
  depreciationExpenseAccountCode: string;
  accumDepreciationAccountCode: string;
}

interface JsonBody {
  entityCode: string;
  code: string;
  description: string;
  category?: string;
  vendorPartyCode?: string;
  acquisitionDate: string;
  acquisitionCost: string | number;
  acquisitionCurrencyCode: string;
  assetAccountCode: string;
  books: BookInput[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // SECURITY (pen-test fix, second pass): switch from legacy single-
  // token to resolveBearerToken so this endpoint participates in the
  // same per-tenant token model as /api/internal/journal-entries.
  // Without it, every caller authenticated as the same "default tenant"
  // identity AND the entity lookup was tenant-blind — fa-amort posting
  // for tenant A could create a FixedAsset under tenant B's entity if
  // the codes matched.
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
      endpoint: "POST /api/internal/fixed-asset",
      reason: "Missing bearer token",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Missing bearer token", 401);
  }
  const identity = await resolveBearerToken(bearer);
  if (!identity) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/fixed-asset",
      reason: "Bearer token did not match any TenantApiToken or INTERNAL_API_TOKEN",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Invalid or revoked bearer token", 401);
  }

  let body: JsonBody;
  try {
    body = (await req.json()) as JsonBody;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  // Minimal field validation; createFixedAsset enforces the rest.
  if (
    !body.entityCode ||
    !body.code ||
    !body.description ||
    !body.acquisitionDate ||
    body.acquisitionCost == null ||
    !body.acquisitionCurrencyCode ||
    !body.assetAccountCode ||
    !Array.isArray(body.books) ||
    body.books.length === 0
  ) {
    return err(
      "BAD_REQUEST",
      "Required: entityCode, code, description, acquisitionDate, acquisitionCost, acquisitionCurrencyCode, assetAccountCode, books (non-empty)",
      400
    );
  }

  // Resolve entity SCOPED TO THE AUTHENTICATED TENANT. Cross-tenant
  // entity codes are invisible — caller sees UNKNOWN_ENTITY, not
  // "wait, you found someone else's entity."
  //
  // RLS Phase 2b: tenant-scoped read runs inside withTenantContext.
  // The cross-tenant probe in the !entity branch below stays OUTSIDE
  // (intentional global lookup; same security-feature pattern as
  // /api/internal/journal-entries — needs rethinking at Phase 3 FORCE).
  const entity = await withTenantContext(identity.tenantId, async (tx) =>
    tx.legalEntity.findFirst({
      where: { tenantId: identity.tenantId, code: body.entityCode },
      select: { id: true, code: true },
    })
  );
  if (!entity) {
    // Audit cross-tenant probe attempts: if the entity exists in
    // SOME OTHER tenant, log it as a privacy event (same pattern as
    // /api/internal/journal-entries). Caller still sees UNKNOWN_ENTITY.
    const elsewhere = await prisma.legalEntity.findFirst({
      where: { code: body.entityCode },
      select: { tenantId: true },
    });
    if (elsewhere && elsewhere.tenantId !== identity.tenantId) {
      await auditTokenUse({
        success: false,
        endpoint: "POST /api/internal/fixed-asset",
        reason: "Tenant scope mismatch — token does not own this entity",
        tenantId: identity.tenantId,
        metadata: {
          tokenLabel: identity.label,
          tokenTenantId: identity.tenantId,
          entityCode: body.entityCode,
          elsewhereTenantId: elsewhere.tenantId,
        },
        requestHeaders: reqHeaders,
      });
    }
    return err(
      "UNKNOWN_ENTITY",
      `No entity with code "${body.entityCode}"`,
      422
    );
  }

  // Idempotency: if a FixedAsset already exists at (entityId, code),
  // return it. The caller's accept flow is safe to retry; we don't
  // want two assets for one AiAssetSuggestion.
  //
  // RLS Phase 2b: lookup runs inside withTenantContext.
  const existing = await withTenantContext(identity.tenantId, async (tx) =>
    tx.fixedAsset.findUnique({
      where: { entityId_code: { entityId: entity.id, code: body.code } },
      select: { id: true, code: true },
    })
  );
  if (existing) {
    return NextResponse.json({
      ok: true,
      id: existing.id,
      code: existing.code,
      wasDuplicate: true,
    });
  }

  try {
    // RLS Phase 2b Class T: call createFixedAssetInTx from inside
    // withTenantContext so the GUC reaches all reads (entity lookup,
    // vendor lookup, book lookups) + the nested-create write.
    const result = await withTenantContext(identity.tenantId, async (tx) =>
      createFixedAssetInTx(tx, {
        entityCode: body.entityCode,
        code: body.code,
        description: body.description,
        category: body.category,
        vendorPartyCode: body.vendorPartyCode,
        acquisitionDate: new Date(body.acquisitionDate),
        acquisitionCost: new Decimal(body.acquisitionCost),
        acquisitionCurrencyCode: body.acquisitionCurrencyCode,
        assetAccountCode: body.assetAccountCode,
        books: body.books.map((b) => ({
          bookCode: b.bookCode,
          usefulLifeMonths: b.usefulLifeMonths,
          method: b.method,
          inServiceDate: new Date(b.inServiceDate),
          salvageValue:
            b.salvageValue != null ? new Decimal(b.salvageValue) : undefined,
          depreciationExpenseAccountCode: b.depreciationExpenseAccountCode,
          accumDepreciationAccountCode: b.accumDepreciationAccountCode,
        })),
        sourceSystem: body.sourceSystem,
        sourceRecordType: body.sourceRecordType,
        sourceRecordId: body.sourceRecordId,
        sourcePayload: body.sourcePayload,
      })
    );

    return NextResponse.json({
      ok: true,
      id: result.id,
      code: body.code,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("Party") || msg.toLowerCase().includes("vendor")) {
      return err("UNKNOWN_VENDOR", msg, 422);
    }
    if (msg.includes("Book") || msg.toLowerCase().includes("book")) {
      return err("UNKNOWN_BOOK", msg, 422);
    }
    return err("INTERNAL_ERROR", msg, 500);
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "POST only. Include `Authorization: Bearer $INTERNAL_API_TOKEN` and a body with entityCode, code, description, acquisitionDate, acquisitionCost, acquisitionCurrencyCode, assetAccountCode, books[].",
      },
    },
    { status: 405 }
  );
}
