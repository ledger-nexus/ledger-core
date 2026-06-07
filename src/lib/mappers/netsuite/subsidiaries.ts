// NetSuite Subsidiary → ledger-core LegalEntity mapping (v0.7).
//
// NS multi-subsidiary support. Each Subsidiary becomes its own LegalEntity
// in ledger-core with `parentEntityId` reflecting the NS hierarchy. The
// orchestrator builds an internalid → LegalEntity.id map that downstream
// import steps use to route transactions to the correct entity by
// reading the `subsidiary` field on each NS transaction.
//
// Design: docs/netsuite-multi-subsidiary-design.md
//
// Two-pass orchestrator:
//   Pass 1 — upsert every subsidiary flat (no parent link). This handles
//            the case where NS exports a parent AFTER a child in the JSON
//            array — we don't depend on input ordering.
//   Pass 2 — walk the array again, look up each subsidiary's parent by
//            internalid, set `parentEntityId` accordingly.
//
// Idempotent: re-running the importer upserts existing entities by code.
// The composite [tenantId, code] unique constraint protects against
// cross-tenant collisions.

import type { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import type { NsSubsidiary } from "./types";

// ─── Entity resolution ────────────────────────────────────────────────────
//
// How the orchestrator derives ledger-core entityCodes from NS Subsidiary
// records. Two modes:
//
//   - "single": every subsidiary collapses to ONE LegalEntity. Backward
//     compat with v0.6 callers that pass `entityCode`.
//   - "multi": each subsidiary maps to its own LegalEntity, code derived
//     from a prefix + the NS internalid (e.g., "ACME" + "1" → "ACME_NS1").

export type EntityResolution =
  | { mode: "single"; entityCode: string }
  | { mode: "multi"; entityCodePrefix: string };

/**
 * Compute the ledger-core entityCode for a given NS Subsidiary internalid
 * under the chosen resolution mode. Used both at setup time (creating
 * the LegalEntity) and at per-transaction routing time (looking up which
 * entity a transaction's `subsidiary` field points at).
 */
export function resolveEntityCode(
  internalid: string,
  resolution: EntityResolution
): string {
  if (resolution.mode === "single") return resolution.entityCode;
  return `${resolution.entityCodePrefix}_NS${internalid}`;
}

// ─── Pure mapper ───────────────────────────────────────────────────────────
//
// Pure transformation from NsSubsidiary to the shape we'll pass to
// prisma.legalEntity.upsert. Side-effect-free. The orchestrator wraps
// this with the upsert + the two-pass parent wiring.

export interface MappedSubsidiary {
  /** The ledger-core entity code derived per the resolution mode. */
  code: string;
  /** The NS subsidiary internalid (preserved for lineage + parent lookup). */
  internalid: string;
  /** Human-readable subsidiary name from NS. */
  name: string;
  /** Functional currency code from NS (e.g. "USD", "GBP"). */
  functionalCurrencyCode: string;
  /** NS internalid of the parent subsidiary, if any. */
  parentInternalid: string | null;
  /** True iff NS marks this as an intercompany elimination subsidiary. */
  isElimination: boolean;
  /**
   * The frozen original NS object — lands in extensions JSONB so the
   * reverse exporter can reconstruct the Subsidiary array without
   * re-deriving anything.
   */
  sourcePayload: NsSubsidiary;
}

export function mapSubsidiary(
  ns: NsSubsidiary,
  resolution: EntityResolution
): MappedSubsidiary {
  return {
    code: resolveEntityCode(ns.internalid, resolution),
    internalid: ns.internalid,
    name: ns.name,
    functionalCurrencyCode: ns.currency,
    parentInternalid: ns.parent?.internalid ?? null,
    isElimination: ns.iselimination === true,
    sourcePayload: ns,
  };
}

// ─── Orchestrator step ────────────────────────────────────────────────────
//
// Walks the Subsidiary array in two passes (flat upsert, then parent
// wiring) and returns an `internalid → LegalEntity.id` map for downstream
// transaction routing.

export interface SetupSubsidiariesInput {
  subsidiaries: NsSubsidiary[];
  resolution: EntityResolution;
}

export interface SetupSubsidiariesResult {
  /** Maps NS Subsidiary.internalid → ledger-core LegalEntity.id. */
  entityByInternalid: Map<string, string>;
  /** Count of subsidiaries upserted (new + reused). */
  subsidiariesUpserted: number;
  /**
   * Non-fatal warnings the operator should see — e.g. a subsidiary whose
   * `parent.internalid` doesn't resolve in the same export. These flow
   * to ImportFromNsResult.warnings[] for surfacing in the UI.
   */
  warnings: string[];
}

export async function setupSubsidiaries(
  prisma: PrismaClient,
  input: SetupSubsidiariesInput
): Promise<SetupSubsidiariesResult> {
  const tenantId = await getDefaultTenantId(prisma);
  const warnings: string[] = [];

  if (input.subsidiaries.length === 0) {
    return {
      entityByInternalid: new Map(),
      subsidiariesUpserted: 0,
      warnings,
    };
  }

  // Verify every distinct subsidiary currency exists as a Currency row.
  // LegalEntity.functionalCurrencyId actually holds the Currency.code
  // string (PK = ISO 4217), so we don't need an id lookup — just
  // existence check. Missing currency is fatal: operator must seed it
  // first. (Northwind seed covers USD/EUR/GBP.)
  const distinctCurrencies = Array.from(
    new Set(input.subsidiaries.map((s) => s.currency))
  );
  const currencyRows = await prisma.currency.findMany({
    where: { code: { in: distinctCurrencies } },
    select: { code: true },
  });
  const seededCurrencies = new Set(currencyRows.map((c) => c.code));
  for (const code of distinctCurrencies) {
    if (!seededCurrencies.has(code)) {
      throw new Error(
        `NetSuite Subsidiary references currency "${code}" not seeded in ledger-core. ` +
          `Seed the Currency row first (Northwind seed covers USD/EUR/GBP).`
      );
    }
  }

  // Pass 1 — upsert flat, no parent links. We don't depend on input
  // ordering; parents may be later in the array than children.
  const entityByInternalid = new Map<string, string>();
  let upserted = 0;
  for (const ns of input.subsidiaries) {
    const m = mapSubsidiary(ns, input.resolution);
    const entity = await prisma.legalEntity.upsert({
      where: { tenantId_code: { tenantId, code: m.code } },
      create: {
        tenantId,
        code: m.code,
        name: m.name,
        functionalCurrencyId: m.functionalCurrencyCode,
        extensions: {
          nsIsImported: true,
          nsInternalid: m.internalid,
          nsIsElimination: m.isElimination,
          // Preserve the frozen original NsSubsidiary object so the
          // reverse exporter can reconstruct the Subsidiary array
          // byte-for-byte — matches the lineage-replay pattern that
          // Account/Party/Item/JE rows use via `sourcePayload`.
          nsSourcePayload: m.sourcePayload as unknown as object,
        },
      },
      update: {
        name: m.name,
        // Don't reassign functionalCurrencyId on update — NS sub currency
        // changes are rare and would require re-translating historical
        // postings (out of scope here). The warning below catches drift.
        extensions: {
          nsIsImported: true,
          nsInternalid: m.internalid,
          nsIsElimination: m.isElimination,
          // Preserve the frozen original NsSubsidiary object so the
          // reverse exporter can reconstruct the Subsidiary array
          // byte-for-byte — matches the lineage-replay pattern that
          // Account/Party/Item/JE rows use via `sourcePayload`.
          nsSourcePayload: m.sourcePayload as unknown as object,
        },
      },
      select: { id: true, functionalCurrencyId: true },
    });
    if (entity.functionalCurrencyId !== m.functionalCurrencyCode) {
      warnings.push(
        `Subsidiary ${m.internalid} (${m.name}) has currency "${m.functionalCurrencyCode}" in NS ` +
          `but ledger-core already has currency "${entity.functionalCurrencyId}" for entity ${m.code}. ` +
          `Existing functional currency preserved; postings will use it.`
      );
    }
    entityByInternalid.set(m.internalid, entity.id);
    upserted += 1;
  }

  // Pass 2 — wire parent links. Skip subsidiaries where parent isn't in
  // the same export (treated as top-level + warning).
  for (const ns of input.subsidiaries) {
    if (!ns.parent) continue;
    const parentInternalid = ns.parent.internalid;
    const parentEntityId = entityByInternalid.get(parentInternalid);
    if (!parentEntityId) {
      warnings.push(
        `Subsidiary ${ns.internalid} (${ns.name}) references parent ${parentInternalid} ` +
          `that isn't present in the same NS export. Treating as top-level.`
      );
      continue;
    }
    const childEntityId = entityByInternalid.get(ns.internalid)!;
    // Idempotent — re-running sets the same parentEntityId.
    await prisma.legalEntity.update({
      where: { id: childEntityId },
      data: { parentEntityId },
    });
  }

  return { entityByInternalid, subsidiariesUpserted: upserted, warnings };
}

// ─── Resolution helper from ImportFromNsInput ─────────────────────────────
//
// Backward compat: the legacy ImportFromNsInput shape passes `entityCode`
// directly (single-sub mode). New callers pass `entityResolution`. This
// helper folds either into a canonical EntityResolution.
//
// Exposed for the orchestrator + for tests that want to verify the
// fallback shape resolves correctly.

export function resolveEntityResolution(input: {
  entityCode?: string;
  entityResolution?: EntityResolution;
}): EntityResolution {
  if (input.entityResolution) return input.entityResolution;
  if (input.entityCode) {
    return { mode: "single", entityCode: input.entityCode };
  }
  throw new Error(
    "importFromNs requires either `entityCode` (single-sub mode) or " +
      "`entityResolution` (single or multi-sub mode)."
  );
}
