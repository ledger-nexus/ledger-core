// POST /api/internal/journal-entries
//
// Internal endpoint for trusted sibling repos (recon, revenue-rec,
// fa-amort, integrations) to post journal entries through the canonical
// postJournalEntry path. Gated by INTERNAL_API_TOKEN — fails closed if
// unset.
//
// This is the architectural boundary the portfolio narrative depends on:
// "AI suggests; humans approve; ledger-core posts." Recon's adjustment-JE
// Server Action POSTs here AFTER a human click — never the model's.
//
// IDEMPOTENCY: if the request includes a complete lineage triple
// (sourceSystem + sourceRecordType + sourceRecordId), the endpoint first
// looks for an existing entry with that exact triple. If found, returns
// the existing entry's id/entryNumber WITHOUT inserting again, with
// `wasDuplicate: true` in the response. This lets fa-amort's
// per-(asset×book×month) JE posts and integrations' Plaid-transaction
// JE posts be retried safely after partial failures.
//
// Race safety: a Postgres partial unique index on the triple (where all
// three are not null) is added by `pnpm db:push:portable` — see
// docs/portable-sql.md. Without that index, a true race between two
// concurrent posts with the same triple may both succeed; with it, the
// loser hits a unique violation which the endpoint catches and converts
// to a duplicate-response.
//
// Wire format:
//   POST /api/internal/journal-entries
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   Body: JournalEntryInputJSON (see types below — dates as ISO strings,
//         decimals as decimal strings)
//
// Success (200):
//   { ok: true, id, entryNumber, bookCode, wasDuplicate?: boolean }
//
// Failure (4xx/5xx):
//   { ok: false, error: { code, message } }
//   - code is one of: UNBALANCED, INVALID_LINE, UNKNOWN_ACCOUNT,
//     UNKNOWN_ENTITY, UNKNOWN_BOOK, PERIOD_CLOSED, ACCOUNT_BOOK_SCOPE,
//     UNAUTHORIZED, BAD_REQUEST, INTERNAL_ERROR.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { auditTokenUse } from "@/lib/audit/log";
import {
  UnbalancedEntryError,
  InvalidLineError,
  UnknownAccountError,
  UnknownEntityError,
  UnknownBookError,
  PeriodClosedError,
  AccountBookScopeError,
  type JournalEntryInput,
  type JournalLineInput,
} from "@/lib/accounting/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JsonLineInput {
  accountCode: string;
  debit?: string | number;
  credit?: string | number;
  description?: string;
  partyCode?: string;
  itemCode?: string;
  transactionAmount?: string | number;
  reportingAmount?: string | number;
  extensions?: Record<string, unknown>;
}

interface JsonEntryInput {
  entityCode: string;
  bookCode?: string;
  currencyCode?: string;
  fxRate?: string | number;
  documentDate: string; // ISO date
  postingDate?: string;
  memo: string;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
  lines: JsonLineInput[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
  mappingVersion?: string;
  extensions?: Record<string, unknown>;
}

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function lineFromJson(l: JsonLineInput): JournalLineInput {
  return {
    accountCode: l.accountCode,
    debit: l.debit !== undefined ? new Decimal(l.debit) : undefined,
    credit: l.credit !== undefined ? new Decimal(l.credit) : undefined,
    description: l.description,
    partyCode: l.partyCode,
    itemCode: l.itemCode,
    transactionAmount:
      l.transactionAmount !== undefined ? new Decimal(l.transactionAmount) : undefined,
    reportingAmount:
      l.reportingAmount !== undefined ? new Decimal(l.reportingAmount) : undefined,
    extensions: l.extensions,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // SOC 2 CC6 (logical access controls): every internal-API request
  // is audit-logged regardless of outcome. The audit row is the
  // primary control for detecting credential misuse or scanning
  // attempts on this endpoint.
  const reqHeaders = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/journal-entries",
      reason: "INTERNAL_API_TOKEN not set — endpoint disabled",
      requestHeaders: reqHeaders,
    });
    return err(
      "UNAUTHORIZED",
      "INTERNAL_API_TOKEN env var is not set — endpoint disabled. Set it in the deployment env to enable.",
      503
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${token}`) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/journal-entries",
      reason: authHeader ? "Invalid bearer token" : "Missing bearer token",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Invalid or missing bearer token", 401);
  }
  // Success path — log AFTER we've fully consumed the body + dispatched.
  // We don't log here to avoid double-logging (one per-request, one
  // post-create); the actual `postJournalEntry` success branch writes
  // the row at the bottom of this handler.

  let body: JsonEntryInput;
  try {
    body = (await req.json()) as JsonEntryInput;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  if (!body.entityCode || !body.memo || !Array.isArray(body.lines)) {
    return err(
      "BAD_REQUEST",
      "Required fields: entityCode (string), memo (string), lines (array)",
      400
    );
  }

  let input: JournalEntryInput;
  try {
    input = {
      entityCode: body.entityCode,
      bookCode: body.bookCode,
      currencyCode: body.currencyCode,
      fxRate: body.fxRate !== undefined ? new Decimal(body.fxRate) : undefined,
      documentDate: new Date(body.documentDate),
      postingDate: body.postingDate ? new Date(body.postingDate) : undefined,
      memo: body.memo,
      source: body.source,
      lines: body.lines.map(lineFromJson),
      sourceSystem: body.sourceSystem,
      sourceRecordType: body.sourceRecordType,
      sourceRecordId: body.sourceRecordId,
      sourcePayload: body.sourcePayload,
      mappingVersion: body.mappingVersion,
      extensions: body.extensions,
    };
  } catch (e) {
    return err(
      "BAD_REQUEST",
      `Failed to parse input: ${e instanceof Error ? e.message : "Unknown error"}`,
      400
    );
  }

  // Idempotency check: full lineage triple → look up existing entry first.
  const hasFullLineage =
    !!body.sourceSystem && !!body.sourceRecordType && !!body.sourceRecordId;
  if (hasFullLineage) {
    const existing = await findByLineage(
      body.sourceSystem!,
      body.sourceRecordType!,
      body.sourceRecordId!
    );
    if (existing) {
      return NextResponse.json({
        ok: true,
        id: existing.id,
        entryNumber: existing.entryNumber,
        bookCode: existing.bookCode,
        wasDuplicate: true,
      });
    }
  }

  try {
    const result = await postJournalEntry(prisma, input);
    // SOC 2 CC6: log the successful token use + resulting JE.
    // sourceSystem identifies which sibling repo posted this.
    await auditTokenUse({
      success: true,
      endpoint: "POST /api/internal/journal-entries",
      metadata: {
        sourceSystem: body.sourceSystem,
        sourceRecordType: body.sourceRecordType,
        sourceRecordId: body.sourceRecordId,
        entryNumber: result.entryNumber,
        entityCode: body.entityCode,
        bookCode: result.bookCode,
      },
      requestHeaders: reqHeaders,
    });
    return NextResponse.json({
      ok: true,
      id: result.id,
      entryNumber: result.entryNumber,
      bookCode: result.bookCode,
    });
  } catch (e) {
    // Race-loss case: another concurrent request inserted the same
    // (sourceSystem, sourceRecordType, sourceRecordId) triple between
    // our lookup and our insert. Catch the unique-violation, refetch,
    // and return as duplicate. Only relevant when the partial unique
    // index exists; harmless otherwise.
    if (hasFullLineage && isUniqueViolation(e)) {
      const existing = await findByLineage(
        body.sourceSystem!,
        body.sourceRecordType!,
        body.sourceRecordId!
      );
      if (existing) {
        return NextResponse.json({
          ok: true,
          id: existing.id,
          entryNumber: existing.entryNumber,
          bookCode: existing.bookCode,
          wasDuplicate: true,
        });
      }
    }
    if (e instanceof UnbalancedEntryError) return err("UNBALANCED", e.message, 422);
    if (e instanceof InvalidLineError) return err("INVALID_LINE", e.message, 422);
    if (e instanceof UnknownAccountError) return err("UNKNOWN_ACCOUNT", e.message, 422);
    if (e instanceof UnknownEntityError) return err("UNKNOWN_ENTITY", e.message, 422);
    if (e instanceof UnknownBookError) return err("UNKNOWN_BOOK", e.message, 422);
    if (e instanceof PeriodClosedError) return err("PERIOD_CLOSED", e.message, 409);
    if (e instanceof AccountBookScopeError)
      return err("ACCOUNT_BOOK_SCOPE", e.message, 422);
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown error during postJournalEntry",
      500
    );
  }
}

// Look up an existing entry by lineage triple. Returns null if none.
async function findByLineage(
  sourceSystem: string,
  sourceRecordType: string,
  sourceRecordId: string
): Promise<{ id: string; entryNumber: string; bookCode: string } | null> {
  const found = await prisma.journalEntry.findFirst({
    where: { sourceSystem, sourceRecordType, sourceRecordId },
    select: { id: true, entryNumber: true, book: { select: { code: true } } },
  });
  if (!found) return null;
  return { id: found.id, entryNumber: found.entryNumber, bookCode: found.book.code };
}

// Postgres unique-violation detection. Prisma wraps it as P2002; raw
// pg errors use code "23505". Either path here means we lost a race.
function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  // @ts-expect-error narrow without importing Prisma error namespace
  const code = e.code as string | undefined;
  return code === "P2002" || code === "23505";
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "POST only. Include `Authorization: Bearer $INTERNAL_API_TOKEN` and a JournalEntryInput JSON body.",
      },
    },
    { status: 405 }
  );
}
