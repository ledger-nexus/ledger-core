// Multi-entity consolidation report.
//
// Walks the LegalEntity.parentEntityId hierarchy under a root entity,
// aggregates trial balances across all descendants, and eliminates
// intercompany balances (DUE_FROM_AFFILIATE / DUE_TO_AFFILIATE,
// INTERCOMPANY_REV / INTERCOMPANY_EXP). The result is what a parent
// company would report as the consolidated group's financial position.
//
// Elimination is subtype-driven: any account whose subtype is in the
// IC list is zeroed out at the consolidated level. In practice IC balances
// should net to zero across entities if the underlying transactions are
// recorded consistently; if they don't, the report shows the imbalance
// as a sanity check.
//
// Caveat: this v1.0 implementation handles two-party intercompany via
// subtype tags. Three-way IC chains, intercompany inventory in transit,
// and FX-driven IC imbalances are real-world refinements not modeled here.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { getTrialBalance } from "../reports";
import { signFor } from "../types";

const IC_ASSET_SUBTYPES = ["DUE_FROM_AFFILIATE"];
const IC_LIAB_SUBTYPES = ["DUE_TO_AFFILIATE"];
const IC_REV_SUBTYPES = ["INTERCOMPANY_REV"];
const IC_EXP_SUBTYPES = ["INTERCOMPANY_EXP"];
const ALL_IC_SUBTYPES = [...IC_ASSET_SUBTYPES, ...IC_LIAB_SUBTYPES, ...IC_REV_SUBTYPES, ...IC_EXP_SUBTYPES];

export interface ConsolidatedRow {
  accountCode: string;
  accountName: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  subtype: string | null;
  perEntity: { entityCode: string; debit: Decimal; credit: Decimal }[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  isEliminated: boolean;
  eliminatedDebit: Decimal;
  eliminatedCredit: Decimal;
  consolidatedDebit: Decimal;
  consolidatedCredit: Decimal;
  consolidatedBalance: Decimal; // signed on the normal-balance side
}

export interface EliminationSummaryRow {
  accountCode: string;
  accountName: string;
  subtype: string;
  totalDebitEliminated: Decimal;
  totalCreditEliminated: Decimal;
  // The expected pair (e.g. DUE_FROM_AFFILIATE expects DUE_TO_AFFILIATE)
  // — used to flag IC imbalance.
  netImbalance: Decimal;
}

export interface ConsolidationReport {
  rootEntityCode: string;
  rootEntityName: string;
  bookCode: string;
  asOf: Date;
  /**
   * Each entity in the consolidation hierarchy + its functional currency.
   * The page surfaces a multi-currency-disclosure banner when the set of
   * currencies has more than one distinct value (see `hasMultiCurrency`).
   */
  entitiesIncluded: {
    code: string;
    name: string;
    isRoot: boolean;
    functionalCurrencyId: string;
  }[];
  rows: ConsolidatedRow[];
  eliminationSummary: EliminationSummaryRow[];

  // Pre-elimination totals (per-entity sum)
  preEliminationTotalDebit: Decimal;
  preEliminationTotalCredit: Decimal;

  // Post-elimination totals
  consolidatedTotalDebit: Decimal;
  consolidatedTotalCredit: Decimal;
  balances: boolean;

  // Net IC imbalance: if all IC pairs net to zero, this is zero.
  // Non-zero indicates one side recorded but not the other, or FX drift.
  netIcImbalance: Decimal;

  /**
   * True iff the included entities have more than one distinct
   * functional currency. When true, the consolidated totals are NOT
   * FX-translated — they're naïve sums of each entity's debit/credit
   * in its own currency. The page surfaces a disclosure banner. The
   * proper translation (current rate / temporal / current-rate with
   * CTA accounting per ASC 830) is a follow-up arc.
   */
  hasMultiCurrency: boolean;
  /** The distinct currencies present in the included entities. */
  distinctCurrencies: string[];
}

export async function getConsolidatedTrialBalance(
  prisma: PrismaClient,
  input: {
    rootEntityCode: string;
    bookCode?: string;
    asOf: Date;
    /**
     * Tenant the root entity must belong to. UI/API callers MUST pass
     * this (from the session, never from client input) — the root code
     * arrives as a query param, and without the tenant filter a caller
     * could name another tenant's entity code and consolidate that
     * tenant's books. Omitting it falls back to the legacy global
     * lookup; substrate seeds + single-tenant tests omit this.
     */
    tenantId?: string;
  }
): Promise<ConsolidationReport> {
  const bookCode = input.bookCode ?? "US_GAAP";

  // Resolve the root first so we can constrain the hierarchy walk to the
  // root's tenant. Without this, after Phase 4b composite-uniques allow
  // duplicate codes across tenants, an unscoped findMany would pull
  // entities from other tenants into the consolidation.
  const root = await prisma.legalEntity.findFirst({
    where: input.tenantId
      ? { tenantId: input.tenantId, code: input.rootEntityCode }
      : { code: input.rootEntityCode },
    select: {
      id: true,
      code: true,
      name: true,
      parentEntityId: true,
      tenantId: true,
      functionalCurrencyId: true,
    },
  });
  if (!root) {
    throw new Error(`Root entity ${input.rootEntityCode} not found`);
  }

  // Walk the entity hierarchy WITHIN the same tenant only. Cross-tenant
  // hierarchy traversal is not supported (would be a privacy violation).
  // functionalCurrencyId is pulled so we can compute hasMultiCurrency
  // for the disclosure banner — see ConsolidationReport.hasMultiCurrency.
  const allEntities = await prisma.legalEntity.findMany({
    where: { tenantId: root.tenantId },
    select: {
      id: true,
      code: true,
      name: true,
      parentEntityId: true,
      functionalCurrencyId: true,
    },
  });

  const included: typeof allEntities = [root];
  const queue = [root.id];
  const seen = new Set<string>([root.id]);
  while (queue.length) {
    const parentId = queue.shift()!;
    const children = allEntities.filter((e) => e.parentEntityId === parentId);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      included.push(child);
      queue.push(child.id);
    }
  }

  // Get TB per entity. Some entities (the parent) may have no activity —
  // their TB is empty and contributes nothing. tenantId pins each TB's
  // entity resolution to the root's tenant — entity codes are only
  // unique per tenant (Phase 4b), so an unscoped lookup could resolve a
  // same-code entity in another tenant.
  const perEntityTbs = await Promise.all(
    included.map(async (e) => ({
      entity: e,
      tb: await getTrialBalance(
        prisma,
        { entityCode: e.code, bookCode, tenantId: root.tenantId },
        input.asOf
      ),
    }))
  );

  // Aggregate by accountCode.
  type Aggregate = {
    code: string;
    name: string;
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
    isContra: boolean;
    perEntity: { entityCode: string; debit: Decimal; credit: Decimal }[];
  };
  const aggregates = new Map<string, Aggregate>();

  for (const { entity, tb } of perEntityTbs) {
    for (const row of tb.rows) {
      const existing = aggregates.get(row.accountCode);
      const debit = row.debit;
      const credit = row.credit;
      if (existing) {
        existing.perEntity.push({ entityCode: entity.code, debit, credit });
      } else {
        aggregates.set(row.accountCode, {
          code: row.accountCode,
          name: row.accountName,
          type: row.type,
          isContra: false, // gets filled in below
          perEntity: [{ entityCode: entity.code, debit, credit }],
        });
      }
    }
  }

  // Pull account metadata (subtype + isContra) for classification.
  // Scoped to the root's tenant: account codes are only unique per
  // tenant, and subtype drives IC elimination — a same-code account in
  // another tenant with an IC subtype would otherwise zero out a real
  // balance here (and isContra would flip the displayed sign).
  const accountMeta = await prisma.account.findMany({
    where: { tenantId: root.tenantId, code: { in: Array.from(aggregates.keys()) } },
    select: { code: true, subtype: true, isContra: true },
  });
  const metaByCode = new Map(accountMeta.map((a) => [a.code, a]));

  // Build the consolidated rows + classify eliminations.
  const rows: ConsolidatedRow[] = [];
  const eliminationByCode = new Map<string, EliminationSummaryRow>();

  let preTotalDebit = new Decimal(0);
  let preTotalCredit = new Decimal(0);
  let consolTotalDebit = new Decimal(0);
  let consolTotalCredit = new Decimal(0);

  for (const agg of aggregates.values()) {
    const meta = metaByCode.get(agg.code);
    const subtype = meta?.subtype ?? null;
    const isContra = meta?.isContra ?? false;
    const isEliminated = subtype !== null && ALL_IC_SUBTYPES.includes(subtype);

    const totalDebit = agg.perEntity.reduce((acc, p) => acc.plus(p.debit), new Decimal(0));
    const totalCredit = agg.perEntity.reduce((acc, p) => acc.plus(p.credit), new Decimal(0));

    const eliminatedDebit = isEliminated ? totalDebit : new Decimal(0);
    const eliminatedCredit = isEliminated ? totalCredit : new Decimal(0);

    const consolidatedDebit = totalDebit.minus(eliminatedDebit);
    const consolidatedCredit = totalCredit.minus(eliminatedCredit);

    const sign = signFor(agg.type, isContra);
    const consolidatedBalance =
      sign === 1 ? consolidatedDebit.minus(consolidatedCredit) : consolidatedCredit.minus(consolidatedDebit);

    rows.push({
      accountCode: agg.code,
      accountName: agg.name,
      type: agg.type,
      subtype,
      perEntity: agg.perEntity,
      totalDebit,
      totalCredit,
      isEliminated,
      eliminatedDebit,
      eliminatedCredit,
      consolidatedDebit,
      consolidatedCredit,
      consolidatedBalance,
    });

    preTotalDebit = preTotalDebit.plus(totalDebit);
    preTotalCredit = preTotalCredit.plus(totalCredit);
    consolTotalDebit = consolTotalDebit.plus(consolidatedDebit);
    consolTotalCredit = consolTotalCredit.plus(consolidatedCredit);

    if (isEliminated && subtype) {
      eliminationByCode.set(agg.code, {
        accountCode: agg.code,
        accountName: agg.name,
        subtype,
        totalDebitEliminated: eliminatedDebit,
        totalCreditEliminated: eliminatedCredit,
        netImbalance: new Decimal(0), // computed below
      });
    }
  }

  // Sort rows by account code for stable display.
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  // IC imbalance check: sum eliminated debits across IC accounts should
  // equal sum eliminated credits. If not, one side of an IC was booked
  // and the other wasn't (or FX drift). Show that as a sanity check.
  const totalIcDebit = Array.from(eliminationByCode.values()).reduce(
    (acc, e) => acc.plus(e.totalDebitEliminated),
    new Decimal(0)
  );
  const totalIcCredit = Array.from(eliminationByCode.values()).reduce(
    (acc, e) => acc.plus(e.totalCreditEliminated),
    new Decimal(0)
  );
  const netIcImbalance = totalIcDebit.minus(totalIcCredit);

  // Multi-currency disclosure data. If the included entities have more
  // than one distinct functional currency, the post-elim totals are
  // NOT FX-translated — they're naïve sums of debit/credit values in
  // each entity's own currency. The UI surfaces a banner. The proper
  // ASC 830 translation arc (current rate / temporal / CTA accounting)
  // is deferred and tracked separately. See
  // docs/netsuite-multi-subsidiary-design.md "Non-goals (deferred)".
  const distinctCurrencies = Array.from(
    new Set(included.map((e) => e.functionalCurrencyId))
  ).sort();

  return {
    rootEntityCode: root.code,
    rootEntityName: root.name,
    bookCode,
    asOf: input.asOf,
    entitiesIncluded: included.map((e) => ({
      code: e.code,
      name: e.name,
      isRoot: e.code === root.code,
      functionalCurrencyId: e.functionalCurrencyId,
    })),
    rows,
    eliminationSummary: Array.from(eliminationByCode.values()).sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode)
    ),
    preEliminationTotalDebit: preTotalDebit,
    preEliminationTotalCredit: preTotalCredit,
    consolidatedTotalDebit: consolTotalDebit,
    consolidatedTotalCredit: consolTotalCredit,
    balances: consolTotalDebit.equals(consolTotalCredit),
    netIcImbalance,
    hasMultiCurrency: distinctCurrencies.length > 1,
    distinctCurrencies,
  };
}
