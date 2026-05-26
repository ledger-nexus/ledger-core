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
  createFixedAsset,
  type FixedAssetBookSpec,
} from "@/lib/accounting/sub-ledgers/fixed-assets";

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
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return err(
      "UNAUTHORIZED",
      "INTERNAL_API_TOKEN env var is not set — endpoint disabled.",
      503
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${token}`) {
    return err("UNAUTHORIZED", "Invalid or missing bearer token", 401);
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

  // Resolve entity for the dedup check. Phase 4b: code unique per
  // [tenantId, code], use findFirst.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: body.entityCode },
    select: { id: true, code: true },
  });
  if (!entity) {
    return err(
      "UNKNOWN_ENTITY",
      `No entity with code "${body.entityCode}"`,
      422
    );
  }

  // Idempotency: if a FixedAsset already exists at (entityId, code),
  // return it. The caller's accept flow is safe to retry; we don't
  // want two assets for one AiAssetSuggestion.
  const existing = await prisma.fixedAsset.findUnique({
    where: { entityId_code: { entityId: entity.id, code: body.code } },
    select: { id: true, code: true },
  });
  if (existing) {
    return NextResponse.json({
      ok: true,
      id: existing.id,
      code: existing.code,
      wasDuplicate: true,
    });
  }

  try {
    const result = await createFixedAsset(prisma, {
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
    });

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
