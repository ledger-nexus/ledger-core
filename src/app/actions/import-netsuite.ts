"use server";

// Server Action behind the /import/netsuite page.
//
// One endpoint: importNsAction({ exportJson, mode, entityCode?,
// entityCodePrefix?, bookCode? }) — parses the JSON, calls importFromNs,
// returns the result.
//
// Two modes, mirroring the EntityResolution discriminator in the mapper:
//
//   - single: every NS transaction lands in ONE ledger-core LegalEntity.
//     entityCode is required; backward-compat with v0.6 callers.
//
//   - multi: each NS Subsidiary becomes its own LegalEntity. The
//     entityCodePrefix prepends each LegalEntity.code (e.g. "ACME" →
//     "ACME_NS1", "ACME_NS2"). Per-tx routing through the subsidiary
//     field on each transaction.
//
// Security:
//   - requireAdmin: importing rewrites the chart of accounts + posts
//     JEs; only admins can do this.
//   - requireCurrentTenant: the import scopes to one tenant (the
//     mapper uses getDefaultTenantId, which honors auth context).
//   - JSON size limit: 10 MB. NS exports for real customers are
//     typically under 5 MB at this scope; the limit guards against
//     accidentally dumping a multi-gig payload.
//   - JSON.parse failures surface as a clean message rather than a
//     stack trace.

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { logAuditEvent } from "@/lib/audit/log";
import { importFromNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Code-shape validation. Mirrors the client-side regex but MUST be
// re-enforced server-side: a malicious client can bypass the form
// validation and POST arbitrary input directly to the Server Action.
// These constraints protect:
//   - LegalEntity.code unique constraint (column length + character set)
//   - URL routing (e.g. /reports/consolidation?root=PREFIX_NS1)
//   - Log/error messages (no control chars or homoglyph tricks)
const ENTITY_CODE_PREFIX_RX = /^[A-Z0-9_]{1,16}$/i;
// entityCode in single mode must reference an existing LegalEntity.code.
// We still validate shape so an attacker can't probe with control chars.
const ENTITY_CODE_RX = /^[A-Z0-9_-]{1,32}$/i;
// bookCode must reference an existing Book.code.
const BOOK_CODE_RX = /^[A-Z0-9_]{1,32}$/i;
// NS book internalid is a numeric/short string. Used as the keys of
// bookMapping. We constrain shape to prevent JSON injection through
// the dictionary keys.
const NS_INTERNALID_RX = /^[A-Z0-9_-]{1,16}$/i;
// Multi-book mapping cap. Real NS deployments have a handful of
// AccountingBook entries (GAAP + TAX + sometimes IFRS + adjustment);
// 32 is well above any reasonable upper bound and protects against
// memory blowup from a malformed mapping.
const MAX_BOOK_MAPPING_ENTRIES = 32;

export interface ImportNsActionInput {
  exportJson: string;
  /**
   * Mode discriminator. Single collapses every NS subsidiary into
   * one ledger-core entity; multi creates one LegalEntity per NS sub.
   */
  mode: "single" | "multi";
  /** Required when mode === "single". The destination entity code. */
  entityCode?: string;
  /**
   * Required when mode === "multi". Prefix used to derive each
   * LegalEntity.code from the NS Subsidiary internalid.
   */
  entityCodePrefix?: string;
  /** Defaults to US_GAAP in the mapper. Used only when bookMode is "single". */
  bookCode?: string;
  /**
   * v0.9 Phase 5 — book strategy discriminator. Defaults to "single"
   * for backward compat with v0.6/v0.7/v0.8 callers. "multi" enables
   * per-NS-book routing via bookMapping (each NS AccountingBook
   * internalid maps to a ledger-core Book.code).
   */
  bookMode?: "single" | "multi";
  /**
   * Required when bookMode === "multi". Dictionary of
   * `{ [nsBookInternalid]: ledgerCoreBookCode }`. Every NS book in
   * the export must be declared; the importer throws BookNotMappedError
   * otherwise. Empty values are rejected.
   */
  bookMapping?: Record<string, string>;
}

export type ImportNsActionState =
  | { ok?: undefined; error?: undefined }
  | {
      ok: true;
      subsidiariesUpserted: number;
      accountsImported: number;
      accountsSkipped: number;
      partiesImported: number;
      partiesSkipped: number;
      itemsImported: number;
      itemsSkipped: number;
      journalEntriesImported: number;
      journalEntriesSkipped: number;
      arOpenItemsOpened: number;
      apOpenItemsOpened: number;
      paymentsApplied: number;
      dimensionsCreated: number;
      customFieldsRegistered: number;
      warnings: string[];
      entityCodes: string[];
    }
  | { ok: false; error: string; warnings?: string[] };

export async function importNsAction(
  input: ImportNsActionInput
): Promise<ImportNsActionState> {
  // AuthN/Z first — never run the parser on an unauth'd request.
  // We capture the admin identity here so we can attribute the audit
  // log entry below, even on failure paths.
  let adminEmail: string | null = null;
  let tenantId: string | null = null;
  try {
    const u = await requireAdmin();
    adminEmail = u.email;
    const t = await requireCurrentTenant();
    tenantId = t.id;
  } catch {
    // SOC 2: log access denials. An attacker probing the action gets
    // recorded in the access-review trail.
    await logAuditEvent({
      eventType: "ACCESS_DENIED",
      action: "NS_IMPORT_ATTEMPT",
      outcome: "FAILURE",
      resource: "netsuite-import",
      metadata: { reason: "not_admin_or_no_tenant" },
    });
    return { ok: false, error: "Admin access required to run an import." };
  }

  // Size guard. Cheaper than parsing a multi-gig payload that we'd then
  // reject for being too big.
  const byteLength = Buffer.byteLength(input.exportJson, "utf-8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `Payload too large (${Math.round(byteLength / 1024 / 1024)} MB > ${
        MAX_PAYLOAD_BYTES / 1024 / 1024
      } MB). Split the export or contact support.`,
    };
  }

  // Parse.
  let nsExport: NsExport;
  try {
    nsExport = JSON.parse(input.exportJson) as NsExport;
  } catch (err) {
    return {
      ok: false,
      error:
        "Invalid JSON. " +
        (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }

  // Validate the shape minimally — every NS export we recognize has a
  // top-level _meta + at least one transaction or master-data array.
  // A real export missing all of these is operator error (probably
  // pasted the wrong file).
  if (
    !nsExport.Account &&
    !nsExport.JournalEntry &&
    !nsExport.Invoice &&
    !nsExport.VendorBill
  ) {
    return {
      ok: false,
      error:
        "JSON parsed, but doesn't look like a NetSuite export — no Account, JournalEntry, Invoice, or VendorBill arrays found.",
    };
  }

  // Validate mode-specific inputs. The form enforces these client-side
  // too, but the action must NEVER trust the client — a malicious POST
  // can skip the form entirely. Each regex hits ASCII-only + length cap
  // to protect downstream uses (DB unique constraints, URL routing,
  // log/error formatting).
  if (input.mode === "single") {
    if (!input.entityCode || !ENTITY_CODE_RX.test(input.entityCode)) {
      return {
        ok: false,
        error:
          "Invalid entityCode. Must be 1–32 ASCII letters, digits, underscores, or dashes.",
      };
    }
  }
  if (input.mode === "multi") {
    if (
      !input.entityCodePrefix ||
      !ENTITY_CODE_PREFIX_RX.test(input.entityCodePrefix)
    ) {
      return {
        ok: false,
        error:
          "Invalid entityCodePrefix. Must be 1–16 ASCII letters, digits, or underscores.",
      };
    }
    if (!nsExport.Subsidiary?.length) {
      return {
        ok: false,
        error:
          "Multi-sub mode requires a Subsidiary array in the NS export, but found none. Use single mode instead, or re-export with subsidiaries included.",
      };
    }
  }
  if (input.bookCode && !BOOK_CODE_RX.test(input.bookCode)) {
    return {
      ok: false,
      error:
        "Invalid bookCode. Must be 1–32 ASCII letters, digits, or underscores.",
    };
  }

  // v0.9 Phase 5 — multi-book mode validation. The mapping shape comes
  // from operator input via the UI, so we validate it as untrusted: cap
  // size, validate every key (NS internalid shape) + every value
  // (ledger-core Book.code shape). The importer's setupBooks step does
  // a second-stage check that each value references an existing Book
  // row + raises BookNotMappedError if a transaction references an
  // un-mapped book; that's a contract error worth letting bubble.
  const bookMode = input.bookMode ?? "single";
  if (bookMode === "multi") {
    if (!input.bookMapping || typeof input.bookMapping !== "object") {
      return {
        ok: false,
        error:
          "Multi-book mode requires a bookMapping object. Each NS book internalid must map to a ledger-core book code.",
      };
    }
    const mappingKeys = Object.keys(input.bookMapping);
    if (mappingKeys.length === 0) {
      return {
        ok: false,
        error:
          "Multi-book mode requires at least one entry in bookMapping.",
      };
    }
    if (mappingKeys.length > MAX_BOOK_MAPPING_ENTRIES) {
      return {
        ok: false,
        error: `bookMapping has ${mappingKeys.length} entries; max is ${MAX_BOOK_MAPPING_ENTRIES}.`,
      };
    }
    for (const k of mappingKeys) {
      if (!NS_INTERNALID_RX.test(k)) {
        return {
          ok: false,
          error: `Invalid NS book internalid "${k.slice(0, 32)}" in bookMapping. Keys must be 1–16 ASCII letters/digits/underscores/dashes.`,
        };
      }
      const v = input.bookMapping[k];
      if (typeof v !== "string" || !BOOK_CODE_RX.test(v)) {
        return {
          ok: false,
          error: `Invalid book code "${String(v).slice(0, 32)}" for NS book "${k}". Values must be 1–32 ASCII letters/digits/underscores.`,
        };
      }
    }
    // A multi-book import that doesn't declare any AccountingBook in the
    // NS export is operator confusion — they want multi-book but the
    // payload doesn't have multi-book data. setupBooks will warn, but
    // surface it up front so the page error is clear.
    if (!nsExport.AccountingBook?.length) {
      return {
        ok: false,
        error:
          "Multi-book mode requires an AccountingBook array in the NS export, but found none. Use single book mode instead, or re-export with AccountingBook included.",
      };
    }
  }

  // Run the importer.
  try {
    const entityResolution =
      input.mode === "single"
        ? ({ mode: "single", entityCode: input.entityCode! } as const)
        : ({
            mode: "multi",
            entityCodePrefix: input.entityCodePrefix!,
          } as const);

    // v0.9 Phase 5 — pass bookResolution OR bookCode depending on mode.
    // The importer accepts either (resolveBookResolution folds the legacy
    // bookCode shape into a canonical single-mode BookResolution).
    const importInput =
      bookMode === "multi"
        ? {
            entityResolution,
            bookResolution: {
              mode: "multi" as const,
              bookMapping: input.bookMapping!,
            },
            export: nsExport,
          }
        : {
            entityResolution,
            bookCode: input.bookCode,
            export: nsExport,
          };

    const result = await importFromNs(prisma, importInput);

    if (result.errors.length > 0) {
      // Importer-domain errors are operator-actionable (account doesn't
      // balance, unknown currency, etc.) — surfacing them is the whole
      // point. Different from the catch-all below which might leak
      // internal stack info.
      await logAuditEvent({
        eventType: "PRIVILEGED_ACTION",
        action: "NS_IMPORT",
        outcome: "FAILURE",
        actorEmail: adminEmail,
        tenantId,
        resource: "netsuite-import",
        metadata: {
          mode: input.mode,
          errorCount: result.errors.length,
          warningCount: result.warnings.length,
        },
      });
      return {
        ok: false,
        error: result.errors.slice(0, 3).join("; "),
        warnings: result.warnings,
      };
    }

    // Resolve the resulting LegalEntity codes so the page can link
    // straight to /reports/consolidation with the right root.
    const entityCodes: string[] = [];
    if (input.mode === "multi" && nsExport.Subsidiary) {
      for (const sub of nsExport.Subsidiary) {
        entityCodes.push(`${input.entityCodePrefix}_NS${sub.internalid}`);
      }
    } else if (input.entityCode) {
      entityCodes.push(input.entityCode);
    }

    // Bust the chart-of-accounts + JE pages so the import is
    // immediately visible.
    revalidatePath("/accounts");
    revalidatePath("/journal-entries");
    revalidatePath("/reports/consolidation");

    // SOC 2 / change management: every successful import becomes one
    // audit row capturing who ran it, what mode, how much landed. The
    // import itself writes per-JE audit rows via postJournalEntry, so
    // this entry is the operator-level "started this import" signal.
    await logAuditEvent({
      eventType: "DATA_EXPORT",
      action: "NS_IMPORT",
      outcome: "SUCCESS",
      actorEmail: adminEmail,
      tenantId,
      resource: "netsuite-import",
      metadata: {
        mode: input.mode,
        bookMode,
        bookCode: bookMode === "single" ? (input.bookCode ?? "US_GAAP") : undefined,
        bookMappingSize:
          bookMode === "multi"
            ? Object.keys(input.bookMapping!).length
            : undefined,
        subsidiariesUpserted: result.subsidiariesUpserted,
        accountsImported: result.accountsImported,
        journalEntriesImported: result.journalEntriesImported,
        warningCount: result.warnings.length,
        payloadBytes: byteLength,
      },
    });

    return {
      ok: true,
      subsidiariesUpserted: result.subsidiariesUpserted,
      accountsImported: result.accountsImported,
      accountsSkipped: result.accountsSkipped,
      partiesImported: result.partiesImported,
      partiesSkipped: result.partiesSkipped,
      itemsImported: result.itemsImported,
      itemsSkipped: result.itemsSkipped,
      journalEntriesImported: result.journalEntriesImported,
      journalEntriesSkipped: result.journalEntriesSkipped,
      arOpenItemsOpened: result.arOpenItemsOpened,
      apOpenItemsOpened: result.apOpenItemsOpened,
      paymentsApplied: result.paymentsApplied,
      dimensionsCreated: result.dimensionsCreated,
      customFieldsRegistered: result.customFieldsRegistered,
      warnings: result.warnings,
      entityCodes,
    };
  } catch (err) {
    // Catch-all for INTERNAL failures (Prisma error, FK constraint
    // mismatch, etc.) — surfacing err.message could leak DB table names,
    // SQL fragments, or internal stack frames. Return a generic message
    // and log the full error for operator debugging via the audit trail
    // + server console. SOC 2 CC7.1.
    const internalMessage =
      err instanceof Error ? err.message : String(err);
    console.error("[importNsAction] internal error:", internalMessage);
    await logAuditEvent({
      eventType: "SECURITY_EVENT",
      action: "NS_IMPORT",
      outcome: "FAILURE",
      actorEmail: adminEmail,
      tenantId,
      resource: "netsuite-import",
      metadata: {
        mode: input.mode,
        // Truncate so a runaway error message can't flood the audit
        // table. 400 chars is enough for operator triage from logs.
        internalErrorPreview: internalMessage.slice(0, 400),
      },
    });
    return {
      ok: false,
      error:
        "Import failed due to an internal error. The administrator has been notified.",
    };
  }
}
