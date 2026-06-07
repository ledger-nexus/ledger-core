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
import { importFromNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

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
  /** Defaults to US_GAAP in the mapper. */
  bookCode?: string;
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
  try {
    await requireAdmin();
    await requireCurrentTenant();
  } catch {
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

  // Validate mode-specific inputs.
  if (input.mode === "single" && !input.entityCode) {
    return { ok: false, error: "Single-sub mode requires entityCode." };
  }
  if (input.mode === "multi" && !input.entityCodePrefix) {
    return {
      ok: false,
      error: "Multi-sub mode requires entityCodePrefix.",
    };
  }
  if (input.mode === "multi" && !nsExport.Subsidiary?.length) {
    return {
      ok: false,
      error:
        "Multi-sub mode requires a Subsidiary array in the NS export, but found none. Use single mode instead, or re-export with subsidiaries included.",
    };
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

    const result = await importFromNs(prisma, {
      entityResolution,
      bookCode: input.bookCode,
      export: nsExport,
    });

    if (result.errors.length > 0) {
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
    return {
      ok: false,
      error:
        "Import failed: " +
        (err instanceof Error ? err.message : String(err)).slice(0, 400),
    };
  }
}
