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
import { resolveBearerToken } from "@/lib/auth/token";
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
  // Multi-tenancy token binding (Phase 5):
  // Resolve the Bearer token to a tenant. Two paths handled in
  // resolveBearerToken: (1) per-tenant TenantApiToken row, (2) legacy
  // INTERNAL_API_TOKEN env var → default tenant. If neither matches,
  // we reject with 401 and audit-log the rejection.
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (!bearer) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/journal-entries",
      reason: "Missing bearer token",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Missing bearer token", 401);
  }

  const identity = await resolveBearerToken(bearer);
  if (!identity) {
    await auditTokenUse({
      success: false,
      endpoint: "POST /api/internal/journal-entries",
      reason: "Bearer token did not match any TenantApiToken or INTERNAL_API_TOKEN",
      requestHeaders: reqHeaders,
    });
    return err("UNAUTHORIZED", "Invalid or revoked bearer token", 401);
  }
  // identity.tenantId is now the authoritative scope for this request.
  // postJournalEntry asserts the entity belongs to this tenant; cross-
  // tenant attempts fail with TenantScopeMismatchError → 403.

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
      // Token's tenant is the authoritative scope. postJournalEntry
      // rejects with TenantScopeMismatchError if entity belongs elsewhere.
      tenantId: identity.tenantId,
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
  // SECURITY (pen-test fix): scope the lookup to the authenticated
  // tenant. Without this, two tenants using the same lineage triple
  // (entirely plausible — Plaid transaction ids are tenant-agnostic;
  // a hostile actor could probe known ids) would deduplicate against
  // each other and the caller would receive another tenant's JE id.
  const hasFullLineage =
    !!body.sourceSystem && !!body.sourceRecordType && !!body.sourceRecordId;
  if (hasFullLineage) {
    const existing = await findByLineage(
      identity.tenantId,
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
    // sourceSystem identifies which sibling repo posted this; tenantLabel
    // identifies which token authorized it (audit reviews use this to
    // confirm each tenant's tokens are only used by their own systems).
    await auditTokenUse({
      success: true,
      endpoint: "POST /api/internal/journal-entries",
      tenantId: identity.tenantId,
      metadata: {
        sourceSystem: body.sourceSystem,
        sourceRecordType: body.sourceRecordType,
        sourceRecordId: body.sourceRecordId,
        entryNumber: result.entryNumber,
        entityCode: body.entityCode,
        bookCode: result.bookCode,
        tenantId: identity.tenantId,
        tokenLabel: identity.label,
        tokenSource: identity.source,
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
        identity.tenantId,
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
    if (e instanceof UnknownEntityError) {
      // Audit cross-tenant probe attempts. If the entity actually
      // exists in some OTHER tenant, this is a "wrong-tenant token"
      // event — the same SEV-2 incident the legacy
      // TenantScopeMismatchError used to surface, except now the
      // entity lookup is tenant-scoped so the error name shifted.
      // We probe by looking up the entity GLOBALLY (rare path —
      // only fires when the tenant-scoped lookup missed). If found,
      // the attempt was cross-tenant; we audit + still return the
      // information-leak-safe UNKNOWN_ENTITY response to the caller.
      const elsewhere = await prisma.legalEntity.findFirst({
        where: { code: body.entityCode },
        select: { tenantId: true },
      });
      if (elsewhere && elsewhere.tenantId !== identity.tenantId) {
        await auditTokenUse({
          success: false,
          endpoint: "POST /api/internal/journal-entries",
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
      return err("UNKNOWN_ENTITY", e.message, 422);
    }
    if (e instanceof UnknownBookError) return err("UNKNOWN_BOOK", e.message, 422);
    if (e instanceof PeriodClosedError) return err("PERIOD_CLOSED", e.message, 409);
    if (e instanceof AccountBookScopeError)
      return err("ACCOUNT_BOOK_SCOPE", e.message, 422);
    // SOC 2 CC6: cross-tenant write attempts are SEV-2 — audit + 403.
    // The token was valid but tried to write to an entity that belongs
    // to a different tenant. Likely a misconfigured companion repo
    // (wrong tenant token in its env). Investigate before re-enabling.
    if (e instanceof TenantScopeMismatchError) {
      await auditTokenUse({
        success: false,
        endpoint: "POST /api/internal/journal-entries",
        reason: "Tenant scope mismatch — token does not own this entity",
        // Scope to the TOKEN's tenant — that's where the privacy
        // boundary lives, even though the request targeted another.
        tenantId: identity.tenantId,
        metadata: {
          tokenLabel: identity.label,
          tokenTenantId: identity.tenantId,
          entityCode: body.entityCode,
        },
        requestHeaders: reqHeaders,
      });
      return err("TENANT_SCOPE_MISMATCH", e.message, 403);
    }
    if (e instanceof EntityMissingTenantError) {
      // Data-integrity bug; refuse rather than silently default. 500 so
      // monitoring catches it as a server-side condition.
      return err("DATA_INTEGRITY", e.message, 500);
    }
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown error during postJournalEntry",
      500
    );
  }
}

// Look up an existing entry by lineage triple, tenant-scoped. Returns
// null if none. Without the tenantId filter, two tenants posting the
// same lineage triple (e.g. identical Plaid transaction ids) would
// dedup against each other and cross-tenant-leak the resulting id.
async function findByLineage(
  tenantId: string,
  sourceSystem: string,
  sourceRecordType: string,
  sourceRecordId: string
): Promise<{ id: string; entryNumber: string; bookCode: string } | null> {
  const found = await prisma.journalEntry.findFirst({
    where: { tenantId, sourceSystem, sourceRecordType, sourceRecordId },
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
