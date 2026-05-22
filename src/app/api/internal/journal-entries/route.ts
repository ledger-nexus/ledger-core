// POST /api/internal/journal-entries
//
// Internal endpoint for trusted sibling repos (recon, revenue-rec) to
// post journal entries through the canonical postJournalEntry path.
// Gated by INTERNAL_API_TOKEN — fails closed if unset.
//
// This is the architectural boundary the portfolio narrative depends on:
// "AI suggests; humans approve; ledger-core posts." Recon's adjustment-JE
// Server Action POSTs here AFTER a human click — never the model's.
//
// Wire format:
//   POST /api/internal/journal-entries
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   Body: JournalEntryInputJSON (see types below — dates as ISO strings,
//         decimals as decimal strings)
//
// Success (200):
//   { ok: true, id, entryNumber, bookCode }
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
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return err(
      "UNAUTHORIZED",
      "INTERNAL_API_TOKEN env var is not set — endpoint disabled. Set it in the deployment env to enable.",
      503
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${token}`) {
    return err("UNAUTHORIZED", "Invalid or missing bearer token", 401);
  }

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

  try {
    const result = await postJournalEntry(prisma, input);
    return NextResponse.json({
      ok: true,
      id: result.id,
      entryNumber: result.entryNumber,
      bookCode: result.bookCode,
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
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown error during postJournalEntry",
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
          "POST only. Include `Authorization: Bearer $INTERNAL_API_TOKEN` and a JournalEntryInput JSON body.",
      },
    },
    { status: 405 }
  );
}
