// POST /api/internal/fixed-asset/record-depreciation
//
// Transactional endpoint that wraps the two cross-repo writes
// fa-amort would otherwise do separately:
//
//   1. Post N journal entries (one per asset-book-month period)
//      via the canonical postJournalEntry path.
//   2. Advance FixedAssetBookAttributes.accumulatedDepreciation +
//      lastDepreciatedThrough on the matching (assetId, bookId) row.
//
// Both happen inside one Prisma transaction. A crash mid-run leaves
// the books unchanged — no drift between posted JEs and book-attrs
// state. This closes fa-amort v0.1's known scoped exception (the
// "two-step write" pattern documented in fa-amort's CLAUDE.md +
// docs/ARCHITECTURE.md).
//
// Gated by INTERNAL_API_TOKEN (same token as /api/internal/journal-entries).
//
// Idempotency: each posted JE gets a deterministic lineage triple
// (sourceSystem='fa-amort', sourceRecordType='DepreciationRun',
// sourceRecordId='<assetId>:<bookCode>:<YYYY-MM-DD>'). The endpoint
// checks for an existing entry with that triple BEFORE inserting; if
// found, it counts as a duplicate and contributes NOTHING new to the
// accumulated depreciation (the prior post already advanced state).
// Re-running the same batch is safe — duplicate periods skip the JE
// post; fresh periods post normally; book-attrs is advanced once at
// the end by the sum of FRESH expense only.
//
// Wire format:
//   POST /api/internal/fixed-asset/record-depreciation
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   {
//     assetCode: "FA-1001",              // FixedAsset.code within entity
//     entityCode: "NORTHWIND",
//     bookCode: "US_GAAP",
//     currencyCode: "USD",               // optional; defaults to asset's acq currency
//     memoPrefix: "Depreciation",        // optional; default "Depreciation"
//     periods: [
//       {
//         periodEnd: "2026-05-31",       // ISO date (last day of month)
//         expenseAmount: "1000.0000"     // decimal string
//       },
//       ...
//     ]
//   }
//
// Success (200):
//   {
//     ok: true,
//     entryNumbers: string[],            // one per period, in order (dups + fresh)
//     duplicateCount: number,            // periods that were already posted
//     freshCount: number,                // periods newly posted this call
//     newAccumulatedDepreciation: string,// after this call
//     newLastDepreciatedThrough: string  // ISO date — max periodEnd across batch
//   }
//
// Failure (4xx/5xx):
//   { ok: false, error: { code, message } }
//   - code: UNAUTHORIZED, BAD_REQUEST, UNKNOWN_ASSET, UNKNOWN_BOOK,
//     NO_BOOK_ATTRIBUTES, UNBALANCED, INVALID_LINE, UNKNOWN_ACCOUNT,
//     UNKNOWN_ENTITY, PERIOD_CLOSED, ACCOUNT_BOOK_SCOPE, INTERNAL_ERROR.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withTenantContext } from "@/lib/db/tenant-context";
import {
  UnbalancedEntryError,
  InvalidLineError,
  UnknownAccountError,
  UnknownEntityError,
  UnknownBookError,
  PeriodClosedError,
  AccountBookScopeError,
  TenantScopeMismatchError,
  EntityMissingTenantError,
} from "@/lib/accounting/types";
import { resolveBearerToken } from "@/lib/auth/token";
import { auditTokenUse } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JsonPeriod {
  periodEnd: string;
  expenseAmount: string | number;
}

interface JsonBody {
  assetCode: string;
  entityCode: string;
  bookCode: string;
  currencyCode?: string;
  memoPrefix?: string;
  periods: JsonPeriod[];
}

type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "UNKNOWN_ASSET"
  | "UNKNOWN_BOOK"
  | "NO_BOOK_ATTRIBUTES"
  | "UNBALANCED"
  | "INVALID_LINE"
  | "UNKNOWN_ACCOUNT"
  | "UNKNOWN_ENTITY"
  | "PERIOD_CLOSED"
  | "ACCOUNT_BOOK_SCOPE"
  | "TENANT_SCOPE_MISMATCH"
  | "DATA_INTEGRITY"
  | "INTERNAL_ERROR";

function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Multi-tenancy token binding (Phase 5). Same pattern as
  // /api/internal/journal-entries — resolve Bearer to a TenantApiToken
  // row OR fall back to the legacy INTERNAL_API_TOKEN env value.
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
      endpoint: "POST /api/internal/fixed-asset/record-depreciation",
      reason: "Missing bearer token",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Missing bearer token", 401);
  }
  const identity = await resolveBearerToken(bearer);
  if (!identity) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/fixed-asset/record-depreciation",
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

  if (
    !body.assetCode ||
    !body.entityCode ||
    !body.bookCode ||
    !Array.isArray(body.periods)
  ) {
    return err(
      "BAD_REQUEST",
      "Required: assetCode, entityCode, bookCode, periods (array)",
      400
    );
  }

  if (body.periods.length === 0) {
    return err(
      "BAD_REQUEST",
      "periods array is empty — nothing to post.",
      400
    );
  }

  // Resolve asset + book + attrs.
  const asset = await prisma.fixedAsset.findFirst({
    where: { code: body.assetCode, entity: { code: body.entityCode } },
    select: {
      id: true,
      code: true,
      description: true,
      acquisitionCurrencyId: true,
      entity: { select: { id: true, code: true } },
    },
  });
  if (!asset) {
    return err(
      "UNKNOWN_ASSET",
      `No FixedAsset with code "${body.assetCode}" under entity "${body.entityCode}"`,
      422
    );
  }

  const book = await prisma.book.findUnique({
    where: { code: body.bookCode },
    select: { id: true, code: true },
  });
  if (!book) {
    return err("UNKNOWN_BOOK", `No Book with code "${body.bookCode}"`, 422);
  }

  const bookAttrs = await prisma.fixedAssetBookAttributes.findUnique({
    where: { assetId_bookId: { assetId: asset.id, bookId: book.id } },
    select: {
      accumulatedDepreciation: true,
      lastDepreciatedThrough: true,
      depreciationExpenseAccountCode: true,
      accumDepreciationAccountCode: true,
    },
  });
  if (!bookAttrs) {
    return err(
      "NO_BOOK_ATTRIBUTES",
      `No FixedAssetBookAttributes for asset "${body.assetCode}" book "${body.bookCode}"`,
      422
    );
  }

  // Parse periods up-front (errors here aren't transactional).
  let parsedPeriods: Array<{ periodEnd: Date; expenseAmount: Decimal }>;
  try {
    parsedPeriods = body.periods.map((p, idx) => {
      const dt = new Date(p.periodEnd);
      if (Number.isNaN(dt.getTime())) {
        throw new Error(`period ${idx}: invalid periodEnd ${p.periodEnd}`);
      }
      const amt = new Decimal(p.expenseAmount);
      if (amt.isNegative()) {
        throw new Error(`period ${idx}: expenseAmount must be non-negative`);
      }
      return { periodEnd: dt, expenseAmount: amt };
    });
  } catch (e) {
    return err(
      "BAD_REQUEST",
      `Failed to parse periods: ${e instanceof Error ? e.message : "Unknown error"}`,
      400
    );
  }

  const memoPrefix = body.memoPrefix ?? "Depreciation";
  const currencyCode = body.currencyCode ?? asset.acquisitionCurrencyId;
  const maxPeriodEnd = parsedPeriods.reduce(
    (acc, p) => (p.periodEnd > acc ? p.periodEnd : acc),
    parsedPeriods[0].periodEnd
  );

  // Transactional: post each JE (dedup-aware), then advance book-attrs.
  // We track fresh vs. duplicate periods explicitly so the book-attrs
  // advance only credits new posts (duplicates' expense was already
  // absorbed by the prior call that created them).
  const entryNumbers: string[] = [];
  let freshExpense = new Decimal(0);
  let duplicateCount = 0;
  let freshCount = 0;

  // RLS Phase 2b: replace prisma.$transaction with withTenantContext.
  // The outer block IS a $transaction with the GUC set; postJournalEntry
  // is already tx-aware per ledger-core v1.11. Per-period postJournalEntry
  // calls share ONE tx (this is the substrate-contract — the route's
  // batch atomicity guarantee is "all-or-none for this request").
  //
  // Pre-existing security gap NOT entangled with this migration: the
  // asset lookup above uses `entity: { code: ... }` without an
  // identity.tenantId scope. Phase 3 FORCE will block cross-tenant
  // reads, surfacing this as a proper UNKNOWN_ASSET. Documented as a
  // separate deficiency to track.
  try {
    const txResult = await withTenantContext(
      identity.tenantId,
      async (tx) => {
        for (const p of parsedPeriods) {
          const sourceRecordId = `${asset.id}:${book.code}:${p.periodEnd
            .toISOString()
            .slice(0, 10)}`;

          const existing = await tx.journalEntry.findFirst({
            where: {
              sourceSystem: "fa-amort",
              sourceRecordType: "DepreciationRun",
              sourceRecordId,
            },
            select: { entryNumber: true },
          });
          if (existing) {
            entryNumbers.push(existing.entryNumber);
            duplicateCount += 1;
            continue;
          }

          const memo = `${memoPrefix} — ${asset.code} ${asset.description.slice(
            0,
            40
          )} (${book.code}) — ${p.periodEnd.toISOString().slice(0, 7)}`;

          const result = await postJournalEntry(tx, {
            // Token's tenant is authoritative — engine rejects if the
            // asset's entity belongs elsewhere.
            tenantId: identity.tenantId,
            entityCode: asset.entity.code,
            bookCode: book.code,
            currencyCode,
            documentDate: p.periodEnd,
            memo,
            source: "SYSTEM",
            sourceSystem: "fa-amort",
            sourceRecordType: "DepreciationRun",
            sourceRecordId,
            lines: [
              {
                accountCode: bookAttrs.depreciationExpenseAccountCode,
                debit: p.expenseAmount,
                description: `Depreciation expense ${asset.code}`,
              },
              {
                accountCode: bookAttrs.accumDepreciationAccountCode,
                credit: p.expenseAmount,
                description: `Accumulated depreciation ${asset.code}`,
              },
            ],
          });
          entryNumbers.push(result.entryNumber);
          freshExpense = freshExpense.plus(p.expenseAmount);
          freshCount += 1;
        }

        // Advance book-attrs ONCE at the end, by fresh expense only.
        // Duplicates' expense was already included in the row from the
        // prior call. lastDepreciatedThrough moves to max(periodEnd)
        // across the whole batch even when nothing was fresh — repeats
        // are idempotent on this field too.
        const currentAccum = new Decimal(bookAttrs.accumulatedDepreciation.toString());
        const newAccum = currentAccum.plus(freshExpense);
        const currentLast = bookAttrs.lastDepreciatedThrough;
        const newLast =
          !currentLast || maxPeriodEnd > currentLast ? maxPeriodEnd : currentLast;

        await tx.fixedAssetBookAttributes.update({
          where: { assetId_bookId: { assetId: asset.id, bookId: book.id } },
          data: {
            accumulatedDepreciation: newAccum.toFixed(4),
            lastDepreciatedThrough: newLast,
          },
        });

        return {
          newAccumulated: newAccum.toFixed(4),
          newLast: newLast.toISOString().slice(0, 10),
        };
      },
      // Extended timeout for large batch posts. Forwarded to $transaction
      // by withTenantContext's options parameter.
      { timeout: 30_000 }
    );

    return NextResponse.json({
      ok: true,
      entryNumbers,
      duplicateCount,
      freshCount,
      newAccumulatedDepreciation: txResult.newAccumulated,
      newLastDepreciatedThrough: txResult.newLast,
    });
  } catch (e) {
    if (e instanceof UnbalancedEntryError) return err("UNBALANCED", e.message, 422);
    if (e instanceof InvalidLineError) return err("INVALID_LINE", e.message, 422);
    if (e instanceof UnknownAccountError) return err("UNKNOWN_ACCOUNT", e.message, 422);
    if (e instanceof UnknownEntityError) return err("UNKNOWN_ENTITY", e.message, 422);
    if (e instanceof UnknownBookError) return err("UNKNOWN_BOOK", e.message, 422);
    if (e instanceof PeriodClosedError) return err("PERIOD_CLOSED", e.message, 409);
    if (e instanceof AccountBookScopeError)
      return err("ACCOUNT_BOOK_SCOPE", e.message, 422);
    if (e instanceof TenantScopeMismatchError) {
      await auditTokenUse({
        success: false,
        endpoint: "POST /api/internal/fixed-asset/record-depreciation",
        reason: "Tenant scope mismatch — token does not own this asset's entity",
        tenantId: identity.tenantId,
        metadata: {
          tokenLabel: identity.label,
          tokenTenantId: identity.tenantId,
          entityCode: body.entityCode,
          assetCode: body.assetCode,
        },
        requestHeaders: reqHeaders,
      });
      return err("TENANT_SCOPE_MISMATCH", e.message, 403);
    }
    if (e instanceof EntityMissingTenantError) {
      return err("DATA_INTEGRITY", e.message, 500);
    }
    return err(
      "INTERNAL_ERROR",
      e instanceof Error
        ? e.message
        : "Unknown error during transactional depreciation post",
      500
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "POST only. Include `Authorization: Bearer $INTERNAL_API_TOKEN` and a body with assetCode, entityCode, bookCode, periods[].",
      },
    },
    { status: 405 }
  );
}
